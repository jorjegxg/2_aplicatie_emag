const emag = require("./emag");
const trendyol = require("./trendyol");

const REGISTRY = { emag, trendyol };

function getChannel(name) {
  const key = String(name || "emag").trim().toLowerCase();
  const channel = REGISTRY[key];
  if (!channel) {
    const err = new Error(`Canal necunoscut: ${name}`);
    err.status = 400;
    throw err;
  }
  return channel;
}

function listChannels() {
  return Object.values(REGISTRY).map((c) => ({
    id: c.id,
    label: c.label,
    configured: c.configured !== false,
  }));
}

module.exports = { getChannel, listChannels };
