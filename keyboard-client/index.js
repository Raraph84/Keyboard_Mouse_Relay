const net = require("net");
const libnut = require("../libnut-core");
const keymap = require("./keymap");

require("dotenv").config();

Object.assign(keymap, {
    "AC_HOME": "escape",
    "CAPS_LOCK": null,
    "INSERT": null
});

const repeatAfter = 250;
const repeatInterval = 50;

let lastKey = null;

const keyPressed = (key) => {

    const mapped = keymap[key];
    if (!mapped) return;

    libnut.keyToggle(mapped, "down");

    if (lastKey && lastKey.key === key) return;

    if (lastKey && lastKey.timeout) clearTimeout(lastKey.timeout);
    if (lastKey && lastKey.interval) clearInterval(lastKey.interval);

    const timeout = setTimeout(() => {

        const interval = setInterval(() => keyPressed(key), repeatInterval);

        lastKey = { key, timeout: null, interval };

    }, repeatAfter);

    lastKey = { key, timeout, interval: null };
};

const keyReleased = (key) => {

    const mapped = keymap[key];
    if (!mapped) return;

    libnut.keyToggle(mapped, "up");

    if (lastKey && lastKey.key === key) {
        if (lastKey.timeout) clearTimeout(lastKey.timeout);
        if (lastKey.interval) clearInterval(lastKey.interval);
        lastKey = null;
    }
};

let lastKeys = [];
const handleKeys = (data) => {

    const keys = data.split(" ").reverse();

    for (const key of lastKeys)
        if (!keys.includes(key))
            keyReleased(key);

    for (const key of keys)
        if (!lastKeys.includes(key))
            keyPressed(key);

    lastKeys = keys;
};

const connect = () => {

    const client = new net.Socket();
    client.connect(process.env.SERVER_PORT, process.env.SERVER_HOST);
    client.on("connect", () => {
        client.write(JSON.stringify({ token: process.env.TOKEN, type: "keyboard" }) + "\n");
        console.log("Connected to the server.");
    });
    client.on("close", () => {
        console.log("Disconnected from the server, reconnecting...");
        setTimeout(connect, 500);
    });
    client.on("error", () => { });

    let data = "";
    client.on("data", (chunk) => {
        data += chunk;
        while (data.includes("\n")) {
            const dataSplit = data.split("\n");
            handleKeys(dataSplit.shift());
            data = dataSplit.join("\n");
        }
    });
};

connect();
