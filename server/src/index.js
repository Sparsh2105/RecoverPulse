require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { createServer } = require('http');
const connectDB = require('./config/db');

const webhookRoutes = require('./routes/webhookRoutes');
const transactionRoutes = require('./routes/transactionRoutes');

const app = express();
const httpServer = createServer(app);

const socket = require('./config/socket');
const io = socket.init(httpServer);
app.set('io', io);

app.use(helmet());
app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

app.use('/api/webhooks', webhookRoutes);
app.use('/api/transactions', transactionRoutes);

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

const startServer = async () => {
  await connectDB();
  httpServer.listen(PORT, () => {
    console.log(`Server started on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
  });
};

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
