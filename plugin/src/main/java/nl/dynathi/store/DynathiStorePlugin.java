package nl.dynathi.store;

import com.google.gson.Gson;
import org.bukkit.Bukkit;
import org.bukkit.ChatColor;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.configuration.ConfigurationSection;
import org.bukkit.plugin.java.JavaPlugin;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;

public final class DynathiStorePlugin extends JavaPlugin {
    private final Gson gson = new Gson();
    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();
    private final Set<String> processedOrders = Collections.synchronizedSet(new HashSet<>());

    private volatile boolean licenseValid;
    private volatile String licenseMessage = "Nog niet gecontroleerd";
    private Path processedOrdersFile;

    @Override
    public void onEnable() {
        saveDefaultConfig();
        ensureServerId();
        loadProcessedOrders();

        validateLicense().thenAccept(valid -> {
            if (!valid && getConfig().getBoolean("license.fail-closed", true)) {
                getLogger().severe("DynathiStore wordt uitgeschakeld vanwege een ongeldige licentie: " + licenseMessage);
                getServer().getScheduler().runTask(this, () -> getServer().getPluginManager().disablePlugin(this));
                return;
            }
            if (valid) startOrderPolling();
        });
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (args.length == 0 || args[0].equalsIgnoreCase("status")) {
            sender.sendMessage(color("&8[&6DynathiStore&8] &7Licentie: " + (licenseValid ? "&ageldig" : "&congeldig") + " &7(" + licenseMessage + ")"));
            sender.sendMessage(color("&8[&6DynathiStore&8] &7Verwerkte bestellingen: &f" + processedOrders.size()));
            return true;
        }

        if (args[0].equalsIgnoreCase("reload")) {
            reloadConfig();
            ensureServerId();
            loadProcessedOrders();
            sender.sendMessage(color("&8[&6DynathiStore&8] &7Configuratie herladen. Licentie wordt opnieuw gecontroleerd."));
            validateLicense();
            return true;
        }

        if (args[0].equalsIgnoreCase("poll")) {
            sender.sendMessage(color("&8[&6DynathiStore&8] &7Bestellingen worden nu gecontroleerd."));
            pollOrders();
            return true;
        }

        return false;
    }

    private void startOrderPolling() {
        long seconds = Math.max(5L, getConfig().getLong("orders.poll-seconds", 15L));
        getServer().getScheduler().runTaskTimerAsynchronously(this, this::pollOrders, 20L, seconds * 20L);
        getLogger().info("Order polling gestart, interval: " + seconds + " seconden.");
    }

    private void pollOrders() {
        if (!licenseValid || !isEnabled()) return;

        String apiUrl = getConfig().getString("orders.api-url", "").trim();
        String apiKey = getConfig().getString("orders.api-key", "").trim();
        String serverId = getConfig().getString("server.id", "").trim();
        if (apiUrl.isEmpty() || apiKey.isEmpty() || serverId.isEmpty()) return;

        String separator = apiUrl.contains("?") ? "&" : "?";
        URI uri = URI.create(apiUrl + separator + "serverId=" + serverId);
        HttpRequest request = HttpRequest.newBuilder(uri)
                .timeout(Duration.ofSeconds(15))
                .header("Authorization", "Bearer " + apiKey)
                .header("Accept", "application/json")
                .GET()
                .build();

        httpClient.sendAsync(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8))
                .thenAccept(response -> {
                    if (response.statusCode() < 200 || response.statusCode() >= 300) {
                        getLogger().warning("Order API antwoordde met HTTP " + response.statusCode());
                        return;
                    }
                    try {
                        OrderResponse result = gson.fromJson(response.body(), OrderResponse.class);
                        if (result == null || result.orders == null) return;
                        for (StoreOrder order : result.orders) processOrder(order);
                    } catch (Exception exception) {
                        getLogger().warning("Kon orderantwoord niet verwerken: " + exception.getMessage());
                    }
                })
                .exceptionally(exception -> {
                    getLogger().warning("Order API niet bereikbaar: " + exception.getMessage());
                    return null;
                });
    }

    private void processOrder(StoreOrder order) {
        if (order == null || isBlank(order.id) || isBlank(order.player) || isBlank(order.product)) return;
        if (processedOrders.contains(order.id)) {
            acknowledgeOrder(order.id, "already_processed", "Order was already processed");
            return;
        }

        boolean onlineOnly = getConfig().getBoolean("orders.execute-only-when-player-online", false);
        if (onlineOnly && Bukkit.getPlayerExact(order.player) == null) return;

        ConfigurationSection section = getConfig().getConfigurationSection("products." + order.product);
        if (section == null) {
            getLogger().warning("Onbekend product in bestelling " + order.id + ": " + order.product);
            acknowledgeOrder(order.id, "failed", "Unknown product");
            return;
        }

        List<String> commands = new ArrayList<>(section.getStringList("commands"));
        if (commands.isEmpty()) {
            getLogger().warning("Product heeft geen commands: " + order.product);
            acknowledgeOrder(order.id, "failed", "Product has no commands");
            return;
        }

        getServer().getScheduler().runTask(this, () -> {
            try {
                for (String rawCommand : commands) {
                    String finalCommand = rawCommand
                            .replace("{player}", order.player)
                            .replace("{order}", order.id)
                            .replace("{product}", order.product);
                    boolean success = Bukkit.dispatchCommand(Bukkit.getConsoleSender(), finalCommand);
                    if (!success) throw new IllegalStateException("Command failed: " + finalCommand);
                }
                markProcessed(order.id);
                acknowledgeOrder(order.id, "delivered", "Commands executed successfully");
                String message = getConfig().getString("messages.order-delivered", "&aBestelling %order% voor %player% is geleverd.")
                        .replace("%order%", order.id)
                        .replace("%player%", order.player);
                getLogger().info(ChatColor.stripColor(color(message)));
            } catch (Exception exception) {
                getLogger().severe("Levering mislukt voor order " + order.id + ": " + exception.getMessage());
                acknowledgeOrder(order.id, "failed", exception.getMessage());
            }
        });
    }

    private void acknowledgeOrder(String orderId, String status, String message) {
        String apiUrl = getConfig().getString("orders.api-url", "").trim();
        String apiKey = getConfig().getString("orders.api-key", "").trim();
        if (apiUrl.isEmpty() || apiKey.isEmpty()) return;

        String baseUrl = apiUrl.endsWith("/orders") ? apiUrl : apiUrl.replaceAll("/$", "");
        URI uri = URI.create(baseUrl + "/" + orderId + "/ack");
        String body = gson.toJson(Map.of("status", status, "message", message == null ? "" : message));
        HttpRequest request = HttpRequest.newBuilder(uri)
                .timeout(Duration.ofSeconds(15))
                .header("Authorization", "Bearer " + apiKey)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8))
                .build();
        httpClient.sendAsync(request, HttpResponse.BodyHandlers.discarding());
    }

    private void loadProcessedOrders() {
        String fileName = getConfig().getString("orders.processed-file", "processed-orders.txt");
        processedOrdersFile = getDataFolder().toPath().resolve(fileName);
        processedOrders.clear();
        try {
            Files.createDirectories(getDataFolder().toPath());
            if (Files.exists(processedOrdersFile)) {
                processedOrders.addAll(Files.readAllLines(processedOrdersFile, StandardCharsets.UTF_8));
            }
        } catch (IOException exception) {
            getLogger().warning("Kon verwerkte bestellingen niet laden: " + exception.getMessage());
        }
    }

    private synchronized void markProcessed(String orderId) throws IOException {
        if (!processedOrders.add(orderId)) return;
        Files.write(processedOrdersFile, processedOrders, StandardCharsets.UTF_8);
    }

    private void ensureServerId() {
        String configured = getConfig().getString("server.id", "").trim();
        if (!configured.isEmpty()) return;

        Path idFile = getDataFolder().toPath().resolve("server-id.txt");
        try {
            Files.createDirectories(getDataFolder().toPath());
            String serverId;
            if (Files.exists(idFile)) {
                serverId = Files.readString(idFile, StandardCharsets.UTF_8).trim();
            } else {
                serverId = UUID.randomUUID().toString();
                Files.writeString(idFile, serverId, StandardCharsets.UTF_8);
            }
            getConfig().set("server.id", serverId);
            saveConfig();
        } catch (IOException exception) {
            throw new IllegalStateException("Kon geen server-id opslaan", exception);
        }
    }

    private CompletableFuture<Boolean> validateLicense() {
        String key = getConfig().getString("license.key", "").trim();
        String product = getConfig().getString("license.product", "dynathistore").trim();
        String url = getConfig().getString("license.validation-url", "").trim();
        String serverId = getConfig().getString("server.id", "").trim();
        String address = getConfig().getString("server.public-address", "").trim();

        if (key.isEmpty() || url.isEmpty() || serverId.isEmpty()) {
            licenseValid = false;
            licenseMessage = "Configuratie ontbreekt";
            return CompletableFuture.completedFuture(false);
        }

        String body = gson.toJson(Map.of(
                "key", key,
                "product", product,
                "serverId", serverId,
                "serverAddress", address,
                "pluginVersion", getPluginMeta().getVersion()
        ));

        HttpRequest request = HttpRequest.newBuilder(URI.create(url))
                .timeout(Duration.ofSeconds(15))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8))
                .build();

        return httpClient.sendAsync(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8))
                .thenApply(response -> {
                    try {
                        LicenseResponse result = gson.fromJson(response.body(), LicenseResponse.class);
                        licenseValid = response.statusCode() >= 200 && response.statusCode() < 300 && result != null && result.valid;
                        licenseMessage = result != null && result.message != null ? result.message : (licenseValid ? "License valid" : "Validation failed");
                    } catch (Exception exception) {
                        licenseValid = false;
                        licenseMessage = "Ongeldig antwoord van licentieserver";
                    }
                    getLogger().info("Licentiecontrole: " + licenseMessage);
                    return licenseValid;
                })
                .exceptionally(exception -> {
                    licenseValid = false;
                    licenseMessage = "Licentieserver niet bereikbaar";
                    getLogger().warning(licenseMessage + ": " + exception.getMessage());
                    return false;
                });
    }

    private boolean isBlank(String value) {
        return value == null || value.trim().isEmpty();
    }

    private String color(String value) {
        return ChatColor.translateAlternateColorCodes('&', value);
    }

    private static final class LicenseResponse {
        private boolean valid;
        private String message;
    }

    private static final class OrderResponse {
        private List<StoreOrder> orders;
    }

    private static final class StoreOrder {
        private String id;
        private String player;
        private String product;
    }
}
