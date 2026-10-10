import { build, loadEnv } from 'vite';

const env = { ...loadEnv('mobile', process.cwd(), 'VITE_'), ...process.env };
const value = env.VITE_SYNCROBEAT_API_URL;
if (!value) throw new Error('Configurá VITE_SYNCROBEAT_API_URL con la dirección HTTPS del servidor de beta antes de compilar. Ver MOBILE.md.');
const server = new URL(value);
if (server.protocol !== 'https:' || server.username || server.password || server.pathname !== '/' || server.search || server.hash) {
  throw new Error('VITE_SYNCROBEAT_API_URL debe ser un origen HTTPS, sin /?room=... ni credenciales.');
}
await build({ mode: 'mobile' });
