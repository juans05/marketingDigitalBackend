/**
 * gemini.js — Shared Google Generative AI (Gemini) client singleton
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');

const debugLogPath = path.join(process.cwd(), 'debug_ai.log');

function logDebug(message) {
  const timestamp = new Date().toISOString();
  const logMsg = `[${timestamp}] ${message}\n`;
  console.log(message);
  try {
    fs.appendFileSync(debugLogPath, logMsg);
  } catch (e) {
    console.error('Failed to write to debug_ai.log', e.message);
  }
}

let gemini = null;

function getGemini() {
  if (!gemini) {
    logDebug('🧪 [Gemini] Verificando API Key: ' + (process.env.GOOGLE_GENERATIVE_AI_API_KEY ? 'Presente' : '⚠️ FALTANTE'));
    if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) throw new Error('GOOGLE_GENERATIVE_AI_API_KEY no configurado');
    gemini = new GoogleGenerativeAI(process.env.GOOGLE_GENERATIVE_AI_API_KEY);
  }
  return gemini;
}

module.exports = {
  getGemini,
};
