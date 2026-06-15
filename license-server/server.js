import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';

const app = express();
const port = Number(process.env.PORT || 5050);
const adminApiKey = process.env.ADMIN_API_KEY || '';
const signingSecret = process.env.LICENSE_SIGNING_SECRET || '';
const dataDir = path.resolve('data');
const dataFile = path.join(dataDir, 'licenses.json');

fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(dataFile)) fs.writeFileSync(dataFile, '[]', 'utf8');

app.use(helmet());
app.use(cors({ origin: false }));
app.use(express.json({ limit: '64kb' }));

function readLicenses() {
  return JSON.parse(fs.readFileSync(dataFile, 'utf8'));
}

function writeLicenses(licenses) {
  fs.writeFileSync(dataFile, JSON.stringify(licenses, null, 2), 'utf8');
}

function createKey() {
  const value = crypto.randomBytes(18).toString('hex').toUpperCase();
  return `DYNA-${value.match(/.{1,6}/g).join('-')}`;
}

function sign(payload) {
  return crypto.createHmac('sha256', signingSecret).update(payload).digest('hex');
}

function requireAdmin(req, res, next) {
  if (!adminApiKey || req.header('x-admin-key') !== adminApiKey) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  next();
}

app.get('/health', (_req, res) => {
  res.json({ success: true, service: 'dynathistore-license-server' });
});

app.post('/api/licenses', requireAdmin, (req, res) => {
  const { customerEmail = '', product = 'dynathistore', maxActivations = 1, expiresAt = null } = req.body || {};
  const licenses = readLicenses();
  const license = {
    id: crypto.randomUUID(),
    key: createKey(),
    customerEmail,
    product,
    status: 'active',
    maxActivations: Math.max(1, Number(maxActivations) || 1),
    activations: [],
    expiresAt,
    createdAt: new Date().toISOString()
  };
  licenses.push(license);
  writeLicenses(licenses);
  res.status(201).json({ success: true, license });
});

app.post('/api/licenses/validate', (req, res) => {
  if (!signingSecret) return res.status(500).json({ success: false, message: 'Server not configured' });

  const { key, product = 'dynathistore', serverId, serverAddress = '', pluginVersion = '' } = req.body || {};
  if (!key || !serverId) return res.status(400).json({ success: false, valid: false, message: 'Missing key or serverId' });

  const licenses = readLicenses();
  const license = licenses.find((item) => item.key === key && item.product === product);
  if (!license) return res.status(404).json({ success: true, valid: false, message: 'License not found' });
  if (license.status !== 'active') return res.json({ success: true, valid: false, message: 'License disabled' });
  if (license.expiresAt && new Date(license.expiresAt) < new Date()) {
    return res.json({ success: true, valid: false, message: 'License expired' });
  }

  let activation = license.activations.find((item) => item.serverId === serverId);
  if (!activation) {
    if (license.activations.length >= license.maxActivations) {
      return res.json({ success: true, valid: false, message: 'Activation limit reached' });
    }
    activation = { serverId, serverAddress, firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), pluginVersion };
    license.activations.push(activation);
  } else {
    activation.lastSeenAt = new Date().toISOString();
    activation.serverAddress = serverAddress;
    activation.pluginVersion = pluginVersion;
  }
  writeLicenses(licenses);

  const checkedAt = new Date().toISOString();
  const signature = sign(`${license.id}:${serverId}:${checkedAt}:true`);
  res.json({ success: true, valid: true, licenseId: license.id, checkedAt, signature });
});

app.patch('/api/licenses/:id/status', requireAdmin, (req, res) => {
  const allowed = new Set(['active', 'suspended', 'revoked']);
  const status = String(req.body?.status || '');
  if (!allowed.has(status)) return res.status(400).json({ success: false, message: 'Invalid status' });
  const licenses = readLicenses();
  const license = licenses.find((item) => item.id === req.params.id);
  if (!license) return res.status(404).json({ success: false, message: 'License not found' });
  license.status = status;
  writeLicenses(licenses);
  res.json({ success: true, license });
});

app.listen(port, () => {
  console.log(`DynathiStore license server listening on port ${port}`);
});
