const net = require("net");
const libnut = require("../libnut-core");
const keymap = require("./keymap");

require("dotenv").config();

Object.assign(keymap, {
    "AC_HOME": "escape",
    "CAPS_LOCK": null
});

let lastKeys = [];
const handle = (data) => {

    const mapped = data.split(" ").map((key) => keymap[key]).filter((key) => key).reverse();

    for (const key of lastKeys)
        if (!mapped.includes(key))
            libnut.keyToggle(key, "up");

    for (const key of mapped)
        if (!lastKeys.includes(key))
            libnut.keyToggle(key, "down");

    lastKeys = mapped;
};

const connect = () => {

    const client = new net.Socket();
    client.connect(3000, "192.168.1.27");
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
            handle(dataSplit.shift());
            data = dataSplit.join("\n");
        }
    });
};

connect();
