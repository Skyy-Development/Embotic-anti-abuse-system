const fetch = require('node-fetch');

const PANEL_URL = "https://panel.embotic.xyz/";
const APP_API_KEY = "";
const CLIENT_API_KEY = "";
const DISCORD_WEBHOOK_URL = "";

const APP_HEADERS = {
    "Authorization": `Bearer ${APP_API_KEY}`,
    "Accept": "application/json",
    "Content-Type": "application/json"
};

const CLIENT_HEADERS = {
    "Authorization": `Bearer ${CLIENT_API_KEY}`,
    "Accept": "application/json",
    "Content-Type": "application/json"
};

let overLimitTracker = {};
const DELAY_BETWEEN_CHECKS_MS = 60000;
const BATCH_SIZE = 5;

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, headers, retries = 3) {
    try {
        const response = await fetch(url, { headers });
        if (response.ok) {
            return await response.json();
        } else if (response.status === 504 && retries > 0) {
            await delay(2000);
            return fetchWithRetry(url, headers, retries - 1);
        }
    } catch (error) {
        console.error('Fetch failed:', error.message);
    }
    return null;
}

async function getAllServersFromAppAPI() {
    const serverUUIDs = [];
    let nextPageUrl = `${PANEL_URL}/api/application/servers?page=1`;

    while (nextPageUrl) {
        const data = await fetchWithRetry(nextPageUrl, APP_HEADERS);
        if (!data) return [];

        for (const server of data.data) {
            if (![1, 6].includes(server.attributes.nest_id)) {
                serverUUIDs.push({
                    uuid: server.attributes.uuid,
                    limits: server.attributes.limits,
                    name: server.attributes.name
                });
            }
        }

        nextPageUrl = data.meta.pagination.links.next || null;
    }

    return serverUUIDs;
}

async function getServerResources(server) {
    const url = `${PANEL_URL}/api/client/servers/${server.uuid}/resources`;
    const data = await fetchWithRetry(url, CLIENT_HEADERS);
    if (!data) return;

    const resources = data.attributes.resources;
    const memoryGB = resources.memory_bytes / (1024 ** 3);
    const diskGB = resources.disk_bytes / (1024 ** 3);
    const cpuUsage = resources.cpu_absolute;

    const memoryLimitGB = server.limits.memory / 1024;
    const diskLimitGB = server.limits.disk / 1024;
    const cpuLimit = server.limits.cpu;

    if (
        (cpuLimit > 0 && cpuUsage >= cpuLimit) ||
        (server.limits.memory > 0 && memoryGB >= memoryLimitGB) ||
        (server.limits.disk > 0 && diskGB >= diskLimitGB)
    ) {
        if (!overLimitTracker[server.uuid]?.reported) {
            await notifyServerOverLimit(server, cpuUsage, cpuLimit, memoryGB, memoryLimitGB, diskGB, diskLimitGB);
            overLimitTracker[server.uuid] = { reported: true };
        }
    } else if (overLimitTracker[server.uuid]) {
        delete overLimitTracker[server.uuid];
    }
}

async function notifyServerOverLimit(server, cpuUsage, cpuLimit, memoryGB, memoryLimitGB, diskGB, diskLimitGB) {
    const payload = {
        embeds: [{
            title: `Resource Over Limit: ${server.name}`,
            description: `**CPU Usage:** ${cpuUsage}% (Limit: ${cpuLimit}%)\n**Memory Usage:** ${memoryGB.toFixed(2)} GB (Limit: ${memoryLimitGB.toFixed(2)} GB)\n**Disk Usage:** ${diskGB.toFixed(2)} GB (Limit: ${diskLimitGB.toFixed(2)} GB)`,
            color: 0xffcc00,
            footer: { text: `Server UUID: ${server.uuid}` },
            timestamp: new Date().toISOString(),
        }],
    };

    await fetch(DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
}

(async () => {
    while (true) {
        const servers = await getAllServersFromAppAPI();

        for (let i = 0; i < servers.length; i += BATCH_SIZE) {
            const batch = servers.slice(i, i + BATCH_SIZE);
            await Promise.all(batch.map(server => getServerResources(server)));
            await delay(2000);
        }

        await delay(DELAY_BETWEEN_CHECKS_MS);
    }
})();
