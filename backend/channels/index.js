const emag = require("./emag");
const trendyol = require("./trendyol");
const { isEmagConfigured, isTrendyolConfigured } = require("../credentials-store");

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

async function channelConfigured(c) {
  if (c.id === "emag") return isEmagConfigured();
  if (c.id === "trendyol") return isTrendyolConfigured();
  return true;
}

async function listChannels() {
  const channels = Object.values(REGISTRY);
  return Promise.all(
    channels.map(async (c) => ({
      id: c.id,
      label: c.label,
      configured: await channelConfigured(c),
    }))
  );
}

module.exports = { getChannel, listChannels };
