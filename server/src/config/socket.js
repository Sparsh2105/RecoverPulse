/**
 * @file config/socket.js
 * @description Singleton to manage Socket.io instance across the application.
 */

let io;

module.exports = {
  init: (httpServer) => {
    const { Server } = require('socket.io');
    io = new Server(httpServer, {
      cors: {
        origin: process.env.CLIENT_URL || 'http://localhost:5173',
        methods: ['GET', 'POST'],
      },
    });
    return io;
  },
  getIO: () => {
    if (!io) {
      console.warn('Socket.io is not initialized yet.');
    }
    return io;
  }
};
