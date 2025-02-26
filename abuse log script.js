const fetch = require('node-fetch');

const PANEL_URL = "";
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
const DELAY_BETWEEN_CHECKS_MS = 10000;
const DELAY_BETWEEN_BATCHES_MS = 2000;
const RETRY_LIMIT = 3;
const BATCH_SIZE = 5;
const REPORT_THRESHOLD_SECONDS = 7200;
const KILL_THRESHOLD_SECONDS = 10800;   

function getTimestamp() {
    return new Date().toISOString().replace('T', ' ').substr(0, 19);
}

function log(level, message, serverName = '') {
    const timestamp = getTimestamp();
    console.log(`[${timestamp}] [${level}] ${serverName ? `[${serverName}] ` : ''}${message}`);
}

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, headers, retries = RETRY_LIMIT) {
    log('INFO', `Fetching URL: ${url}`);
    try {
        const response = await fetch(url, { headers });
        if (response.ok) {
            return await response.json();
        } else if (response.status === 504 && retries > 0) {
            log('WARN', `Received 504 error. Retrying... (${RETRY_LIMIT - retries + 1}/${RETRY_LIMIT})`);
            await delay(DELAY_BETWEEN_CHECKS_MS);
            return fetchWithRetry(url, headers, retries - 1);
        } else {
            log('ERROR', `Failed to fetch data: ${response.status} - ${response.statusText}`);
            return null;
        }
    } catch (error) {
        log('ERROR', `Fetch failed due to error: ${error.message}`);
        return null;
    }
}

async function getAllServersFromAppAPI() {
    log('INFO', "Fetching all servers from App API...");
    const serverUUIDs = [];
    let nextPageUrl = `${PANEL_URL}/api/application/servers?page=1`;

    while (nextPageUrl) {
        const data = await fetchWithRetry(nextPageUrl, APP_HEADERS);
        if (!data) return [];

        for (const server of data.data) {
            const nest = server.attributes.nest_id;

            if (nest === 1 || nest === 6) {
                log('INFO', `Skipping game server with nest: ${nest}`, server.attributes.name);
                continue;
            }
            serverUUIDs.push({
                uuid: server.attributes.uuid,
                limits: server.attributes.limits,
                name: server.attributes.name,
                nest: nest 
            });
        }

        nextPageUrl = data.meta.pagination.links.next || null;
    }

    log('INFO', `Retrieved ${serverUUIDs.length} non-game servers.`);
    return serverUUIDs;
}

async function getServerResources(serverUUID, limits, serverName, nest) {

    // Define different thresholds for specific nests
    const isSpecialNest = (nest === 1 || nest === 6);
    const customKillThresholdSeconds = isSpecialNest ? 18000 : KILL_THRESHOLD_SECONDS; 

    log('INFO', `Fetching resources for server UUID: ${serverUUID}`, serverName);
    const url = `${PANEL_URL}/api/client/servers/${serverUUID}/resources`;
    const data = await fetchWithRetry(url, CLIENT_HEADERS);
    if (!data) return;

    const resources = data.attributes.resources;

    const memoryGB = resources.memory_bytes / (1024 ** 3);
    const diskGB = resources.disk_bytes / (1024 ** 3);
    const cpuUsage = resources.cpu_absolute;

    const memoryLimitGB = limits.memory / 1024;
    const diskLimitGB = limits.disk / 1024;
    const cpuLimit = limits.cpu;

    log('INFO', `CPU Usage: ${cpuUsage}% (Limit: ${cpuLimit}%)`, serverName);
    log('INFO', `Memory Usage: ${memoryGB.toFixed(2)} GB (Limit: ${memoryLimitGB.toFixed(2)} GB)`, serverName);
    log('INFO', `Disk Usage: ${diskGB.toFixed(2)} GB (Limit: ${diskLimitGB.toFixed(2)} GB)`, serverName);
    log('INFO', "--------------------------------------------------");

    if (
        (cpuLimit > 0 && cpuUsage >= cpuLimit) ||
        (limits.memory > 0 && memoryGB >= memoryLimitGB) ||
        (limits.disk > 0 && diskGB >= diskLimitGB)
    ) {
        log('WARN', `Server ${serverUUID} is over the limit! Monitoring...`, serverName);

        if (!overLimitTracker[serverUUID]) {
            overLimitTracker[serverUUID] = { startTime: Date.now(), reported: false };
        }

        overLimitTracker[serverUUID].isOverLimit = true;

        const elapsedTime = (Date.now() - overLimitTracker[serverUUID].startTime) / 1000;


        if (elapsedTime >= REPORT_THRESHOLD_SECONDS && !overLimitTracker[serverUUID].reported) {
            log('WARN', `Server ${serverUUID} has been over the limit for 2 hours. Sending report...`, serverName);
            await notifyServerOverLimit(serverUUID, limits, resources, serverName);
            overLimitTracker[serverUUID].reported = true;
        }

        if (elapsedTime >= customKillThresholdSeconds) {
            log('ERROR', `Server ${serverUUID} has been over the limit for 5 hours! Taking action...`, serverName);
            await killServer(serverUUID, serverName);
            await logToDiscord(serverUUID, `Server with UUID ${serverUUID} got killed for maxing out resources for 5 hours straight!`, serverName);
            delete overLimitTracker[serverUUID];  
        }

    } else {
        if (overLimitTracker[serverUUID]) {
            log('INFO', `Server ${serverUUID} is back within limits. Resetting timer.`, serverName);
            delete overLimitTracker[serverUUID];
        }
    }
}

async function notifyServerOverLimit(serverUUID, limits, resources, serverName) {
    log('WARN', `Notifying that server ${serverUUID} is over its limit.`, serverName);
    const memoryGB = resources.memory_bytes / (1024 ** 3);
    const diskGB = resources.disk_bytes / (1024 ** 3);
    const cpuUsage = resources.cpu_absolute;

    const memoryLimitGB = limits.memory / 1024;
    const diskLimitGB = limits.disk / 1024;
    const cpuLimit = limits.cpu;

    const payload = {
        embeds: [{
            title: `Server Over Limit: ${serverUUID}`,
            description: `The server has exceeded its resource limits for 2 hours.\n\n**CPU Usage**: ${cpuUsage}% (Limit: ${cpuLimit}%)\n**Memory Usage**: ${memoryGB.toFixed(2)} GB (Limit: ${memoryLimitGB.toFixed(2)} GB)\n**Disk Usage**: ${diskGB.toFixed(2)} GB (Limit: ${diskLimitGB.toFixed(2)} GB)`,
            color: 0xffcc00,
            footer: {
                text: `Server UUID: ${serverUUID}`,
            },
            timestamp: new Date(),
        }],
    };

    try {
        const response = await fetch(DISCORD_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            log('ERROR', `Failed to notify about server ${serverUUID}: ${response.status} - ${response.statusText}`, serverName);
        } else {
            log('INFO', `Notification sent for server ${serverUUID} to Discord.`, serverName);
        }
    } catch (error) {
        log('ERROR', `Error sending notification for server ${serverUUID}: ${error.message}`, serverName);
    }
}

async function killServer(serverUUID, serverName) {
    const url = `${PANEL_URL}/api/client/servers/${serverUUID}/power`;
    log('INFO', `Attempting to kill server ${serverUUID}...`, serverName);
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: CLIENT_HEADERS,
            body: JSON.stringify({ signal: 'kill' }),
        });

        if (!response.ok) {
            log('ERROR', `Failed to kill server ${serverUUID}: ${response.status} - ${response.statusText}`, serverName);
        } else {
            log('INFO', `Server ${serverUUID} has been killed.`, serverName);
        }
    } catch (error) {
        log('ERROR', `Error while killing server ${serverUUID}: ${error.message}`, serverName);
    }
}

async function logToDiscord(serverUUID, message, serverName) {
    const payload = {
        embeds: [{
            title: `Action Taken: ${serverUUID}`,
            description: message,
            color: 0xff0000,
            footer: {
                text: `Server UUID: ${serverUUID}`,
            },
            timestamp: new Date(),
        }],
    };

    try {
        const response = await fetch(DISCORD_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            log('ERROR', `Failed to log action for server ${serverUUID}: ${response.status} - ${response.statusText}`, serverName);
        } else {
            log('INFO', `Action logged for server ${serverUUID} to Discord.`, serverName);
        }
    } catch (error) {
        log('ERROR', `Error logging action for server ${serverUUID}: ${error.message}`, serverName);
    }
}

(async () => {
    while (true) {
        const servers = await getAllServersFromAppAPI();

        for (let i = 0; i < servers.length; i += BATCH_SIZE) {
            const batch = servers.slice(i, i + BATCH_SIZE);

            await Promise.all(batch.map(server =>
                getServerResources(server.uuid, server.limits, server.name, server.nest)
            ));

            await delay(DELAY_BETWEEN_BATCHES_MS);
        }

        log('INFO', `Completed resource check for all servers. Sleeping for ${DELAY_BETWEEN_CHECKS_MS / 1000} seconds.`);
        await delay(DELAY_BETWEEN_CHECKS_MS);
    }
})();
