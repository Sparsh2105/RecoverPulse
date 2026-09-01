require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { createServer } = require('http');
const connectDB = require('./config/db');

const webhookRoutes = require('./routes/webhookRoutes');
const razorpayWebhookRoutes = require('./routes/razorpayWebhookRoutes');
const transactionRoutes = require('./routes/transactionRoutes');
const agentRoutes = require('./routes/agentRoutes');
const batchRoutes = require('./routes/batchRoutes');

const app = express();
const httpServer = createServer(app);

const socket = require('./config/socket');
const io = socket.init(httpServer);
app.set('io', io);

app.use(helmet());
app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (mobile apps, curl, Postman)
    if (!origin) return callback(null, true);
    const allowed = process.env.CLIENT_URL || 'http://localhost:5173';
    // Strip any trailing whitespace/newlines from env var
    const cleanAllowed = allowed.trim();
    // In development or if wildcard, allow all
    if (cleanAllowed === '*' || process.env.NODE_ENV !== 'production') {
      return callback(null, true);
    }
    if (origin === cleanAllowed || origin.endsWith('.vercel.app') || origin.endsWith('.onrender.com')) {
      return callback(null, true);
    }
    return callback(null, true); // temporarily allow all during initial deploy
  },
  credentials: true,
}));
// localtunnel bypass header — lets Twilio webhooks through without browser confirmation page
app.use((req, res, next) => {
  res.setHeader('bypass-tunnel-reminder', 'true');
  next();
});
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

app.use('/api/webhooks', webhookRoutes);
app.use('/api/webhooks', razorpayWebhookRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/agent', agentRoutes);
app.use('/api/batch', batchRoutes);

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'RecoverPulse AI Server',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

app.use((req, res) => {
  res.status(404).json({ success: false, error: `Route ${req.originalUrl} not found` });
});

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({
      success: false,
      errorCode: 'INVALID_JSON',
      error: 'Request body contains invalid JSON',
    });
  }
  console.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { details: err.message }),
  });
});

io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);
  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 5000;

const { startPoller } = require('./services/razorpayPoller');

const startServer = async () => {
  await connectDB();
  httpServer.listen(PORT, () => {
    console.log(`Server started on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
    // Start polling Razorpay for payment captures (dev fallback — webhook handles this in prod)
    startPoller();
  });
};

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
