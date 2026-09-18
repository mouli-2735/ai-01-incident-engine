// db.js — single MongoDB Atlas connection for AI-01
const mongoose = require('mongoose');

let connected = false;

async function connectDB() {
  if (connected) return mongoose.connection;

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI is not set. Copy .env.example to .env and fill it in.');
  }

  mongoose.set('strictQuery', true);

  await mongoose.connect(uri, {
    dbName: process.env.MONGODB_DB || 'ai01',
    serverSelectionTimeoutMS: 8000,
  });

  connected = true;
  const host = uri.replace(/^mongodb(\+srv)?:\/\//, '').split('@').pop().split('/')[0];
  console.log(`[db] connected to MongoDB (${host})`);

  mongoose.connection.on('error', (err) => {
    console.error('[db] connection error:', err.message);
  });
  mongoose.connection.on('disconnected', () => {
    connected = false;
    console.warn('[db] disconnected');
  });

  return mongoose.connection;
}

async function disconnectDB() {
  if (!connected) return;
  await mongoose.disconnect();
  connected = false;
}

module.exports = { connectDB, disconnectDB, mongoose };
