import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';

const app = express();
const port = Number(process.env.PORT || 3000);
const pluginApiKey = process.env.PLUGIN_API_KEY || '';
const adminApiKey = process.env.ADMIN_API_KEY || '';
const dataDir = path.resolve('data');
const ordersFile = path.join(dataDir, 'orders.json');

fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(ordersFile)) fs.writeFileSync(ordersFile, '[]', 'utf8');

app.use(helmet());
app.use(express.json({ limit: '64kb' }));

function readOrders() {
  return JSON.parse(fs.readFileSync(ordersFile, 'utf8'));
}

function writeOrders(orders) {
  fs.writeFileSync(ordersFile, JSON.stringify(orders, null, 2), 'utf8');
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

app.get('/health', (_req, res) => {
  res.json({ success: true, service: 'dynathistore-webshop-api' });
});

app.post('/api/admin/orders', requireBearer(adminApiKey), (req, res) => {
  const { player, product, serverId, paymentReference = '', amount = 1 } = req.body || {};
  if (!player || !product || !serverId) {
    return res.status(400).json({ success: false, message: 'player, product and serverId are required' });
  }

  const orders = readOrders();
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
  writeOrders(orders);
  res.status(201).json({ success: true, order });
});

app.get('/api/plugin/orders', requireBearer(pluginApiKey), (req, res) => {
  const serverId = String(req.query.serverId || '');
  if (!serverId) return res.status(400).json({ success: false, message: 'serverId is required' });

  const orders = readOrders()
    .filter((order) => order.serverId === serverId && order.status === 'paid')
    .slice(0, 25)
    .map(({ id, player, product, amount }) => ({ id, player, product, amount }));

  res.json({ success: true, orders });
});

app.post('/api/plugin/orders/:id/ack', requireBearer(pluginApiKey), (req, res) => {
  const { status, message = '' } = req.body || {};
  const allowed = new Set(['delivered', 'failed', 'already_processed']);
  if (!allowed.has(status)) return res.status(400).json({ success: false, message: 'Invalid status' });

  const orders = readOrders();
  const order = orders.find((item) => item.id === req.params.id);
  if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

  if (status === 'delivered' || status === 'already_processed') {
    order.status = 'delivered';
    order.deliveredAt = new Date().toISOString();
  } else {
    order.status = 'delivery_failed';
  }
  order.deliveryMessage = String(message);
  writeOrders(orders);

  res.json({ success: true, order });
});

app.listen(port, () => {
  console.log(`DynathiStore webshop API listening on port ${port}`);
});
