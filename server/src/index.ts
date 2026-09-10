import 'dotenv/config';
import { createAppServer } from './app.js';

const port = Number(process.env.PORT) || 3000;
const allowedOrigins = (process.env.CLIENT_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',').map(origin => origin.trim()).filter(Boolean);
const { httpServer } = createAppServer(allowedOrigins);

httpServer.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
