/**
 * WhatsApp send-only connection for NanoClaw.
 * Auth state is stored in SQLite — no files accumulate in store/auth.
 */
import fs from 'fs';
import {
  AuthenticationCreds,
  AuthenticationState,
  BufferJSON,
  fetchLatestBaileysVersion,
  initAuthCreds,
  makeWASocket,
  SignalDataTypeMap,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
const qrcodeTerminal = _require('qrcode-terminal') as {
  generate: (qr: string, opts: object) => void;
};

import {
  deleteWhatsAppAuthKey,
  getWhatsAppAuthKey,
  getWhatsAppAuthKeysByPrefix,
  setWhatsAppAuthKey,
} from './db.js';
import { logger } from './logger.js';

// Suppress Baileys' verbose pino logger
const P = await import('pino');
const baileysLogger = P.default({ level: 'silent' });

/** SQLite-backed auth state — zero files in store/auth */
function useSQLiteAuthState(): {
  state: AuthenticationState;
  saveCreds: () => void;
} {
  const credsRaw = getWhatsAppAuthKey('creds');
  const creds: AuthenticationCreds = credsRaw
    ? JSON.parse(credsRaw, BufferJSON.reviver)
    : initAuthCreds();

  const keys = {
    get<T extends keyof SignalDataTypeMap>(
      type: T,
      ids: string[],
    ): Promise<{ [id: string]: SignalDataTypeMap[T] }> {
      const raw = getWhatsAppAuthKeysByPrefix(type, ids);
      const result: Record<string, SignalDataTypeMap[T]> = {};
      for (const [id, val] of Object.entries(raw)) {
        result[id] = JSON.parse(val, BufferJSON.reviver);
      }
      return Promise.resolve(result as { [id: string]: SignalDataTypeMap[T] });
    },

    set(data: {
      [T in keyof SignalDataTypeMap]?: {
        [id: string]: SignalDataTypeMap[T] | null;
      };
    }): Promise<void> {
      for (const [type, entries] of Object.entries(data)) {
        if (!entries) continue;
        for (const [id, value] of Object.entries(entries)) {
          if (value == null) {
            deleteWhatsAppAuthKey(`${type}/${id}`);
          } else {
            setWhatsAppAuthKey(
              `${type}/${id}`,
              JSON.stringify(value, BufferJSON.replacer),
            );
          }
        }
      }
      return Promise.resolve();
    },
  };

  const saveCreds = () => {
    setWhatsAppAuthKey('creds', JSON.stringify(creds, BufferJSON.replacer));
  };

  return { state: { creds, keys }, saveCreds };
}

let sock: ReturnType<typeof makeWASocket> | null = null;
let isReady = false;
const sendQueue: Array<{
  jid: string;
  text: string;
  imagePath?: string;
  resolve: () => void;
  reject: (e: Error) => void;
}> = [];

async function sendItem(
  jid: string,
  text: string,
  imagePath?: string,
): Promise<void> {
  if (!sock) throw new Error('Socket not initialized');
  if (imagePath) {
    const image = fs.readFileSync(imagePath);
    await sock.sendMessage(jid, { image, caption: text });
  } else {
    await sock.sendMessage(jid, { text });
  }
}

async function drainQueue() {
  if (!sock || !isReady) return;
  while (sendQueue.length > 0) {
    const item = sendQueue.shift()!;
    try {
      await sendItem(item.jid, item.text, item.imagePath);
      item.resolve();
    } catch (err) {
      item.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

export async function initWhatsAppSender(): Promise<void> {
  const { state, saveCreds } = useSQLiteAuthState();
  const { version } = await fetchLatestBaileysVersion();
  logger.info({ version }, 'WhatsApp client version');

  const connect = () => {
    sock = makeWASocket({
      version,
      auth: state,
      logger: baileysLogger,
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        logger.info('WhatsApp QR code — scan to authenticate:');
        qrcodeTerminal.generate(qr, { small: true });
        QRCode.toFile('/tmp/whatsapp-qr.png', qr, { width: 400 });
      }

      if (connection === 'open') {
        logger.info('WhatsApp sender connected');
        isReady = true;
        drainQueue();
      }

      if (connection === 'close') {
        isReady = false;
        const statusCode = (
          lastDisconnect?.error as { output?: { statusCode?: number } }
        )?.output?.statusCode;
        const shouldReconnect = statusCode !== 401; // 401 = logged out
        logger.warn(
          { statusCode },
          `WhatsApp sender disconnected${shouldReconnect ? ', reconnecting...' : ' (logged out)'}`,
        );
        if (shouldReconnect) {
          setTimeout(connect, 5000);
        }
      }
    });
  };

  connect();
}

export function sendWhatsAppMessage(
  jid: string,
  text: string,
  imagePath?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (sock && isReady) {
      sendItem(jid, text, imagePath)
        .then(() => resolve())
        .catch(reject);
    } else {
      sendQueue.push({ jid, text, imagePath, resolve, reject });
    }
  });
}
