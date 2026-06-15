import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import Stripe from 'stripe';

const app = express();
const port = Number(process.env.PORT || 3000);
const baseUrl = process.env.BASE_URL || `http://localhost:${port}`;
const pluginApiKey = process.env.PLUGIN_API_KEY || '';
const adminApiKey = process.env.ADMIN_API_KEY || '';
const stripeSecretKey = process.env.STRIPE_SECRET_KEY || '';
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';
const defaultServerId = process.env.DEFAULT_SERVER_ID || '';
const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL || '';
const stripe = stripeSecretKey ? new Stripe(stripeSecretKey) : null;

const dataDir = path.resolve('data');
const ordersFile = path.join(dataDir, 'orders.json');
const productsFile = path.join(dataDir, 'products.json');

fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(ordersFile)) fs.writeFileSync(ordersFile, '[]', 'utf8');
if (!fs.existsSync(productsFile)) {
  fs.writeFileSync(productsFile, JSON.stringify([
    { id: 'vip', name: 'VIP Rank', description: 'VIP-rank voor jouw Minecraft-server.', priceCents: 499, currency: 'eur', active: true },
    { id: 'elite', name: 'Elite Rank', description: 'Elite-rank met extra voordelen.', priceCents: 999, currency: 'eur', active: true },
    { id: 'legend', name: 'Legend Rank', description: 'De hoogste premium rank.', priceCents: 1499, currency: 'eur', active: true },
    { id: 'crate_gold_3', name: '3 Gold Crate Keys', description: 'Drie Gold crate keys.', priceCents: 299, currency: 'eur', active: true }
  ], null, 2), 'utf8');
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use('/public', express.static(path.resolve('public')));

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function requireBearer(expectedKey) {
  return (req, res, next) => {
    const value = req.header('authorization') || '';
    if (!expectedKey || value !== `Bearer ${expectedKey}`) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    next();
  };
}

async function sendDiscord(content) {
  if (!discordWebhookUrl) return;
  try {
    await fetch(discordWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    });
  } catch (error) {
    console.error('Discord webhook failed:', error.message);
  }
}

function createPaidOrder({ player, product, serverId, paymentReference, amount = 1 }) {
  const orders = readJson(ordersFile);
  const duplicate = orders.find((order) => order.paymentReference === paymentReference);
  if (duplicate) return duplicate;

  const order = {
    id: crypto.randomUUID(),
    player: String(player),
    product: String(product),
    serverId: String(serverId),
    paymentReference: String(paymentReference),
    amount: Math.max(1, Number(amount) || 1),
    status: 'paid',
    deliveryMessage: '',
    createdAt: new Date().toISOString(),
    deliveredAt: null
  };
  orders.push(order);
  writeJson(ordersFile, orders);
  return order;
}

app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !stripeWebhookSecret) return res.status(503).send('Stripe not configured');

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.header('stripe-signature'), stripeWebhookSecret);
  } catch (error) {
    return res.status(400).send(`Webhook error: ${error.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    if (session.payment_status === 'paid') {
      const { player, product, serverId, amount = '1' } = session.metadata || {};
      if (player && product && serverId) {
        const order = createPaidOrder({
          player,
          product,
          serverId,
          paymentReference: session.id,
          amount
        });
        await sendDiscord(`✅ Betaling ontvangen voor **${player}** — product: **${product}** — order: **${order.id}**`);
      }
    }
  }

  res.json({ received: true });
});

app.use(express.json({ limit: '64kb' }));

app.get('/', (_req, res) => {
  res.sendFile(path.resolve('public/index.html'));
});

app.get('/success', (_req, res) => {
  res.sendFile(path.resolve('public/success.html'));
});

app.get('/cancel', (_req, res) => {
  res.sendFile(path.resolve('public/cancel.html'));
});

app.get('/health', (_req, res) => {
  res.json({ success: true, service: 'dynathistore-webshop-api' });
});

app.get('/api/products', (_req, res) => {
  const products = readJson(productsFile).filter((product) => product.active);
  res.json({ success: true, products });
});

app.post('/api/checkout', async (req, res) => {
  if (!stripe) return res.status(503).json({ success: false, message: 'Stripe is not configured' });

  const player = String(req.body?.player || '').trim();
  const productId = String(req.body?.product || '').trim();
  const serverId = String(req.body?.serverId || defaultServerId).trim();
  const products = readJson(productsFile);
  const product = products.find((item) => item.id === productId && item.active);

  if (!/^[A-Za-z0-9_]{3,16}$/.test(player)) {
    return res.status(400).json({ success: false, message: 'Ongeldige Minecraft-naam' });
  }
  if (!product) return res.status(404).json({ success: false, message: 'Product niet gevonden' });
  if (!serverId) return res.status(400).json({ success: false, message: 'Server ID ontbreekt' });

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card', 'ideal'],
      line_items: [{
        quantity: 1,
        price_data: {
          currency: product.currency,
          unit_amount: product.priceCents,
          product_data: {
            name: product.name,
            description: product.description
          }
        }
      }],
      metadata: {
        player,
        product: product.id,
        serverId,
        amount: '1'
      },
      success_url: `${baseUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/cancel`
    });

    res.json({ success: true, url: session.url });
  } catch (error) {
    console.error('Checkout error:', error);
    res.status(500).json({ success: false, message: 'Kon checkout niet starten' });
  }
});

app.post('/api/admin/orders', requireBearer(adminApiKey), (req, res) => {
  const { player, product, serverId, paymentReference = `manual-${crypto.randomUUID()}`, amount = 1 } = req.body || {};
  if (!player || !product || !serverId) {
    return res.status(400).json({ success: false, message: 'player, product and serverId are required' });
  }

  const order = createPaidOrder({ player, product, serverId, paymentReference, amount });
  res.status(201).json({ success: true, order });
});

app.get('/api/plugin/orders', requireBearer(pluginApiKey), (req, res) => {
  const serverId = String(req.query.serverId || '');
  if (!serverId) return res.status(400).json({ success: false, message: 'serverId is required' });

  const orders = readJson(ordersFile)
    .filter((order) => order.serverId === serverId && order.status === 'paid')
    .slice(0, 25)
    .map(({ id, player, product, amount }) => ({ id, player, product, amount }));

  res.json({ success: true, orders });
});

app.post('/api/plugin/orders/:id/ack', requireBearer(pluginApiKey), async (req, res) => {
  const { status, message = '' } = req.body || {};
  const allowed = new Set(['delivered', 'failed', 'already_processed']);
  if (!allowed.has(status)) return res.status(400).json({ success: false, message: 'Invalid status' });

  const orders = readJson(ordersFile);
  const order = orders.find((item) => item.id === req.params.id);
  if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

  if (status === 'delivered' || status === 'already_processed') {
    order.status = 'delivered';
    order.deliveredAt = new Date().toISOString();
    await sendDiscord(`📦 Bestelling **${order.id}** is geleverd aan **${order.player}**.`);
  } else {
    order.status = 'delivery_failed';
    await sendDiscord(`❌ Levering mislukt voor **${order.player}** — order: **${order.id}** — ${message}`);
  }
  order.deliveryMessage = String(message);
  writeJson(ordersFile, orders);

  res.json({ success: true, order });
});

app.listen(port, () => {
  console.log(`DynathiStore webshop listening on ${baseUrl}`);
});
