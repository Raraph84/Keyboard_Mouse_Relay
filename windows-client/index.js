const { fromByte } = require("../server/utils");
const net = require("net");
const libnut = require("../libnut-core");
const keymap = require("../keyboard-client/keymap");

Object.assign(keymap, {
    "AC_HOME": "escape",
    "CAPS_LOCK": null,
    "INSERT": null
});

const mouseSpeed = 1.1;

const repeatAfter = 250;
const repeatInterval = 50;

require("dotenv").config();

libnut.setMouseDelay(0);

const logon = process.argv.includes("--logon");

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

const connectKeyboard = () => {

    const client = new net.Socket();
    client.connect(logon ? process.env.SERVER_PORT : process.env.LOGON_SERVER_PORT, logon ? process.env.SERVER_HOST : "localhost");
    client.on("connect", () => {
        client.write(JSON.stringify({ token: process.env.TOKEN, type: "keyboard" }) + "\n");
        console.log("Connected to the keyboard server.");
    });
    client.on("close", () => {
        console.log("Disconnected from the keyboard server, reconnecting...");
        setTimeout(connectKeyboard, 500);
    });
    client.on("error", () => { });

    let data = "";
    client.on("data", (chunk) => {
        for (const socket of keyboardSockets) socket.write(chunk);
        data += chunk;
        while (data.includes("\n")) {
            const dataSplit = data.split("\n");
            handleKeys(dataSplit.shift());
            data = dataSplit.join("\n");
        }
    });
};

connectKeyboard();

let lastButton = null;
const handleMouse = (data) => {

    if (data[0] === 0) {

        const x = fromByte(data[1]) * mouseSpeed;
        const y = fromByte(data[2]) * mouseSpeed;

        const old = libnut.getMousePos();
        libnut.moveMouse(old.x + x, old.y + y);

    } else if (data[0] === 1) {

        const button = { 1: "left", 2: "right", 4: "middle" }[data[1]];
        if (button && lastButton !== button) {
            if (lastButton) libnut.mouseToggle("up", lastButton);
            libnut.mouseToggle("down", button);
            lastButton = button;
        } else if (lastButton) {
            libnut.mouseToggle("up", lastButton);
            lastButton = null;
        }

        if (data[2] || data[3]) {

            const yScroll = fromByte(data[2]);
            const xScroll = 0 - fromByte(data[3]);

            if (process.platform === "win32") libnut.scrollMouse(xScroll * 144, yScroll * 144);
            else libnut.scrollMouse(xScroll, yScroll);
        }
    }
};

const connectMouse = () => {

    const client = new net.Socket();
    client.connect(logon ? process.env.SERVER_PORT : process.env.LOGON_SERVER_PORT, logon ? process.env.SERVER_HOST : "localhost");
    client.on("connect", () => {
        client.write(JSON.stringify({ token: process.env.TOKEN, type: "mouse" }) + "\n");
        console.log("Connected to the mouse server.");
    });
    client.on("close", () => {
        console.log("Disconnected from the mouse server, reconnecting...");
        setTimeout(connectMouse, 1000);
    });
    client.on("error", () => { });

    let data = Buffer.alloc(0);
    let nextSize = 0;
    client.on("data", (chunk) => {
        for (const socket of mouseSockets) socket.write(chunk);
        data = Buffer.concat([data, chunk]);
        while (data.length && data.length >= (nextSize = { 0: 3, 1: 4 }[data[0]])) {
            handleMouse(data.subarray(0, nextSize));
            data = data.subarray(nextSize);
        }
    });
};

connectMouse();

const keyboardSockets = [];
const mouseSockets = [];
if (logon) {
    const server = net.createServer((socket) => {

        let type = null;

        let data = "";
        socket.on("data", (chunk) => {

            data += chunk;
            if (!data.includes("\n")) return;

            const message = data.split("\n").shift();

            let json;
            try {
                json = JSON.parse(message);
            } catch (error) {
                socket.end();
                return;
            }

            if (!json.token || json.token !== process.env.TOKEN) {
                socket.end();
                return;
            }

            if (!json.type || !["mouse", "keyboard"].includes(json.type)) {
                socket.end();
                return;
            }

            if (type) {
                socket.end();
                return;
            }

            type = json.type;

            const sockets = json.type === "mouse" ? mouseSockets : keyboardSockets;

            sockets.push(socket);
            console.log("Client connected to the server", socket.remoteAddress, json.type);

            socket.on("close", () => {
                sockets.splice(sockets.indexOf(socket), 1);
                console.log("Client disconnected from the server", socket.remoteAddress, json.type);
            });
        });
        socket.on("error", () => { });
    });
    server.listen(process.env.LOGON_SERVER_PORT, () => console.log("Server started."));
}
