import assert from "node:assert/strict";
import test from "node:test";
import { parseCommandResultShouldStopWatching } from "../src/agent/graph/utils/commandFinished.ts";

test("空快照和普通输出需要继续观察", () => {
    assert.equal(parseCommandResultShouldStopWatching("sleep 5", ""), false);
    assert.equal(parseCommandResultShouldStopWatching("tail -f app.log", "service is running"), false);
});

test("密码和确认提示会停止本轮观察", () => {
    assert.equal(parseCommandResultShouldStopWatching("ssh root@example.com", "root@example.com's password: "), true);
    assert.equal(parseCommandResultShouldStopWatching("apt install demo", "Do you want to continue? [Y/n] "), true);
});

test("远端 Shell 提示符会停止交互式 SSH 的观察", () => {
    assert.equal(parseCommandResultShouldStopWatching("ssh root@example.com", "Last login: today\nroot@example:~# "), true);
});

test("带选项、远端命令和本地管道的 SSH 可以停止观察", () => {
    const command =
        'ssh -vvv -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o PreferredAuthentications=password root@192.168.97.50 "echo ok" 2>&1 | tail -30';
    assert.equal(parseCommandResultShouldStopWatching(command, "root@192.168.97.50's password: "), true);
    assert.equal(parseCommandResultShouldStopWatching(command, "debug1: Exit status 0\nok\nroot@local:~# "), true);
});

test("常见 REPL 提示符会停止本轮观察", () => {
    assert.equal(parseCommandResultShouldStopWatching("python", "Python 3.12\n>>> "), true);
    assert.equal(parseCommandResultShouldStopWatching("mysql", "Welcome to the MySQL monitor\nmysql> "), true);
    assert.equal(parseCommandResultShouldStopWatching("node", "Welcome to Node.js\n> "), true);
});

test("常驻命令退出并交还 Shell 后会停止观察", () => {
    assert.equal(parseCommandResultShouldStopWatching('mysql -e "SELECT 1"', "1\n1\nroot@local:~# "), true);
    assert.equal(parseCommandResultShouldStopWatching("yes | head -n 1", "y\nroot@local:~# "), true);
});

test("会话终止后无需继续观察", () => {
    assert.equal(parseCommandResultShouldStopWatching("exit", "logout"), true);
    assert.equal(parseCommandResultShouldStopWatching("ssh root@example.com", "Connection to example.com closed."), true);
});
