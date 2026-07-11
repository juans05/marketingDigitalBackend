/**
 * anthropic.js — Shared Anthropic client singleton
 */

const Anthropic = require('@anthropic-ai/sdk');
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

let anthropic = null;

function getAnthropic() {
  if (!anthropic) {
    logDebug('🧪 [Anthropic] Verificando API Key: ' + (process.env.ANTHROPIC_API_KEY ? 'Presente' : '⚠️ FALTANTE'));
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY no configurado');
    anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropic;
}

module.exports = {
  getAnthropic,
};
