package nl.dynathi.store;

import com.google.gson.Gson;
import org.bukkit.ChatColor;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
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
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;

public final class DynathiStorePlugin extends JavaPlugin {
    private final Gson gson = new Gson();
    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();

    private volatile boolean licenseValid;
    private volatile String licenseMessage = "Nog niet gecontroleerd";

    @Override
    public void onEnable() {
        saveDefaultConfig();
        ensureServerId();
        validateLicense().thenAccept(valid -> {
            if (!valid && getConfig().getBoolean("license.fail-closed", true)) {
                getLogger().severe("DynathiStore wordt uitgeschakeld vanwege een ongeldige licentie: " + licenseMessage);
                getServer().getScheduler().runTask(this, () -> getServer().getPluginManager().disablePlugin(this));
            }
        });
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (args.length == 0 || args[0].equalsIgnoreCase("status")) {
            sender.sendMessage(color("&8[&6DynathiStore&8] &7Licentie: " + (licenseValid ? "&ageldig" : "&congeldig") + " &7(" + licenseMessage + ")"));
            return true;
        }

        if (args[0].equalsIgnoreCase("reload")) {
            reloadConfig();
            ensureServerId();
            sender.sendMessage(color("&8[&6DynathiStore&8] &7Configuratie herladen. Licentie wordt opnieuw gecontroleerd."));
            validateLicense();
            return true;
        }

        return false;
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

    private String color(String value) {
        return ChatColor.translateAlternateColorCodes('&', value);
    }

    private static final class LicenseResponse {
        private boolean valid;
        private String message;
    }
}
