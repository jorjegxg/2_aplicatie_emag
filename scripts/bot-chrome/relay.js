/**
 * Releu TCP: containerul emag-boti → portul de debug al Chrome-ului boților.
 * Chrome ascultă doar pe 127.0.0.1, iar containerul nu ajunge la localhost-ul PC-ului, așa că
 * deschidem portul doar pe interfața docker0 (172.17.0.1), nu în rețeaua locală.
 */
const net = require("net");

const LISTEN_HOST = process.env.RELAY_HOST || "172.17.0.1";
const LISTEN_PORT = Number(process.env.RELAY_PORT) || 9224;
const TARGET_PORT = Number(process.env.CHROME_PORT) || 9223;

net
  .createServer((client) => {
    const chrome = net.connect(TARGET_PORT, "127.0.0.1");
    client.pipe(chrome).pipe(client);
    const end = () => {
      client.destroy();
      chrome.destroy();
    };
    client.on("error", end);
    chrome.on("error", end);
  })
  .listen(LISTEN_PORT, LISTEN_HOST, () => console.log(`relay ${LISTEN_HOST}:${LISTEN_PORT} → 127.0.0.1:${TARGET_PORT}`));
