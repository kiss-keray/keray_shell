// ===================== 终端观察是否可以停止 =====================
// 思路说明：
// 1. 这里的 true 不是“进程已经退出”，而是“本轮 Tool 已不必继续观察终端”。
//    命令结束、程序等待输入、进入交互提示符和会话退出都应停止观察，把快照交还上层。
// 2. visual 终端拿不到退出码，主要根据增量快照末尾的提示符判断当前状态。
// 3. top、tail -f、vim 这类没有稳定文本提示符的常驻/交互程序，
//    按「命令名 + 参数」识别后直接判未结束，交给外层观察超时兜底（超时会发 Ctrl+C 收快照）。
// 4. ssh/mosh/telnet 特判：远端提示符表示已经进入下一次交互，也应停止本轮观察；
//    logout / Connection closed 等会话终止特征同样表示无需继续等待。
// 5. 驻留判定只看第一个管道段的主命令（sudo -u root ls 归到 ls），不展开管道/复合命令。

/** Shell 提示符形态表：命中说明 Shell 已进入下一次交互，本轮观察可以停止。 */
const SHELL_PROMPT_PATTERNS: RegExp[] = [
    // [user@host dir]$ / [root@host ~]#（RHEL/CentOS/Fedora 默认 bash，% 为 csh/tcsh 变体）
    /\[[\w.+-]+@[\w.-]+[^\]\n]*\]\s*[#$%]\s*$/,
    // user@host:path$ / root@host:~#（Debian/Ubuntu 默认 bash；> 为 fish；不锚定行首，兼容无换行输出后紧跟提示符）
    /[\w.+-]+@[\w.-]+[: ][^\n]{0,100}?[#$%>]\s*$/,
    // bash-5.1$ / sh-4.2#（无 user@host 的兜底 PS1）
    /^(?:-)?(?:bash|sh|zsh|ksh|mksh|dash|ash|csh|tcsh|fish|xonsh|elvish|nu)(?:-[\d.]+)?\s*[#$%>]\s*$/,
    // busybox/alpine 容器：/ #、~ #、/var/log #
    /^[~./][\w./ -]{0,60}#\s*$/,
    // 极简或未配置 PS1：整行只有一个提示符字符（> 是 shell 续行符 PS2，不能算）
    /^[#$%]\s*$/,
    // zsh 默认 host%：要求首尾是字母，避免命中 "disk-50%" 这类百分比输出
    /^[a-zA-Z][\w.-]*[a-zA-Z]%\s*$/,
    // oh-my-zsh robbyrussell 主题：➜  目录 git:(main) ✗
    /^➜\s+\S/,
    // starship / pure / powerlevel10k 主题：以 ❯ 收尾
    /❯\s*$/,
];

/** 等待输入形态表：命中说明程序在等人输入，本轮观察应立即停止。 */
const WAITING_INPUT_PATTERNS: RegExp[] = [
    // sudo/ssh/su/passwd/mysql -p/gpg 等密码口令提示，统一以冒号结尾
    /\[sudo\] password for [^:\n]*:\s*$/i,
    /(?:password|passphrase|密码|口令)[^:\n]*:\s*$/i,
    // ssh 首次连接的主机密钥确认：(yes/no)?、(yes/no/[fingerprint])?
    /\(yes\/no(?:\/\[fingerprint\])?\)\??\s*:?\s*$/i,
    // apt/yum/dnf/fsck 等确认提示：[Y/n]、[y/N]、(yes/no)
    /\[(?:y\/n|yes\/no|no\/yes)\]\s*:?\s*$/i,
    /\((?:y\/n|yes\/no)\)\s*:?\s*$/i,
    /are you sure[^\n]*\?\s*$/i,
    // rm -i / cp -i / mv -i 的逐个确认
    /^(?:rm|cp|mv|ln|install):\s*.+\?\s*$/i,
    // less/more/man 分页器（git log、systemctl status 等输出超屏时也会自动进 pager）
    /^--More--(?:\(\d+%\))?--?\s*$/i,
    /^\(END\)\s*$/,
    /^lines \d+/i,
    /^:\s*$/,
    /press h for help/i,
    /press (?:any key|enter|return|space|q)\b[^\n]*$/i,
    // adduser / aws configure 等带默认值的交互表单：提示语 [默认值]:
    /\[[^\]\n]{0,40}\]:\s*$/,
    // 登录/账号输入
    /^(?:[\w.+-]+\s+)?login:\s*$/i,
    /(?:user ?name|account):\s*$/i,
    // terraform apply 等「Enter a value:」
    /enter a value:\s*$/i,
];

/**
 * 常见 REPL/交互客户端提示符：这些程序仍在运行，但已经可以接收下一段输入。
 * 这里只匹配形态稳定的提示符；全屏 TUI 没有稳定文本标记，仍交给观察超时兜底。
 */
const INTERACTIVE_PROMPT_PATTERNS: RegExp[] = [
    /^(?:>>>|\.\.\.|In \[\d+\]:)\s*$/, // Python / IPython
    /^>\s*$/, // Node/Deno REPL 与 Shell 续行提示符
    /^->\s*$/, // MySQL 多行输入
    /^(?:mysql|sqlite|gnuplot|julia|s?ftp|ftp|php)\s*>\s*$/i,
    /^MariaDB \[[^\]\n]*\]>\s*$/i,
    /^[^\s\n]{1,64}(?:=>|=#|-#|'>|">)\s*$/, // psql 及其多行提示符
    /^(?:\d{1,3}\.){3}\d{1,3}:\d+>\s*$/, // redis-cli
    /^\((?:gdb|lldb)\)\s*$/i,
    /^irb\([^\n]*\):\d+:\d+[>*"]\s*$/i,
];

/** 会话终止特征：命中说明当前交互已结束，本轮观察可以停止。 */
const SESSION_END_PATTERNS: RegExp[] = [
    /^logout\s*$/i, // exit/登出 shell
    /^Connection to \S+ closed\.?\s*$/i, // ssh 正常退出
    /^Connection closed(?: by .+)?\.?\s*$/i, // ssh 被对端断开
    /^Write failed: Broken pipe\s*$/i, // ssh 链路中断
    /^\[detached(?: from .+)?\]\s*$/i, // tmux/screen 分离
    /^\[screen is terminating\]\s*$/i, // screen 会话结束
];

/** 远程会话命令：登录后看到的是远端提示符，本地提示符判定不可信，只能等终止特征 */
const REMOTE_SESSION_COMMANDS = new Set(["ssh", "mosh", "telnet", "rlogin", "rsh", "slogin", "remsh", "plink"]);

/** 常驻/交互命令：不带参数就必定占用终端回不到提示符（是否带参数都按常驻处理） */
const RESIDENT_COMMANDS = new Set([
    // 全屏监控类（自带刷新界面，不会自己退出）
    "htop",
    "btop",
    "atop",
    "nmon",
    "glances",
    "bashtop",
    "btm",
    "zenith",
    "s-tui",
    "powertop",
    "iftop",
    "iotop",
    "nethogs",
    "nload",
    "bmon",
    "slurm",
    "iptraf",
    "iptraf-ng",
    "cbm",
    "bandwhich",
    "wavemon",
    "watch",
    // 分页器与手册
    "less",
    "more",
    "most",
    "man",
    "info",
    "perldoc",
    "pydoc",
    "ri",
    // 编辑器
    "vi",
    "vim",
    "nvim",
    "view",
    "ex",
    "nano",
    "emacs",
    "emacsclient",
    "pico",
    "joe",
    "jed",
    "micro",
    "helix",
    "hx",
    "kak",
    "kakoune",
    "ne",
    "mcedit",
    "visudo",
    "vipw",
    "vigr",
    // 终端复用与串口工具（tmux/screen 子命令差异大，在 isResidentByArgs 里特判）
    "byobu",
    "zellij",
    "dvtm",
    "minicom",
    "picocom",
    "cu",
    "kermit",
    "ttyd",
    // 数据库/消息队列交互客户端
    "mysql",
    "mycli",
    "mariadb",
    "psql",
    "pgcli",
    "litecli",
    "vsql",
    "sqlplus",
    "gqlplus",
    "redis-cli",
    "iredis",
    "mongo",
    "mongosh",
    "influx",
    "clickhouse-client",
    "cqlsh",
    "usql",
    "isql",
    "kafka-console-consumer",
    "kafka-console-consumer.sh",
    "kafka-console-producer",
    "kafka-console-producer.sh",
    "zkCli.sh",
    "zookeeper-shell",
    // 网络设备/蓝牙等交互控制台
    "bluetoothctl",
    "iwctl",
    "vtysh",
    "clish",
    // REPL 与调试器（裸命令才进 REPL 的解释器在 isResidentByArgs 里按参数判）
    "irb",
    "pry",
    "ghci",
    "hugs",
    "clisp",
    "sbcl",
    "erl",
    "iex",
    "radian",
    "gdb",
    "lldb",
    // 网络交互客户端
    "ftp",
    "lftp",
    "sftp",
    "ncftp",
    "nc",
    "ncat",
    "netcat",
    "socat",
    // 文本浏览器与邮件/聊天客户端
    "lynx",
    "w3m",
    "links",
    "links2",
    "elinks",
    "irssi",
    "weechat",
    "finch",
    "mutt",
    "neomutt",
    "alpine",
    "tin",
    "slrn",
    // 文件管理器与 k8s/容器 TUI
    "ranger",
    "nnn",
    "mc",
    "vifm",
    "lf",
    "broot",
    "k9s",
    "lazydocker",
    "lazygit",
    "ctop",
    "dry",
    "stern",
    "kail",
    // 其它常驻程序
    "yes", // 无限输出
    "openvpn",
    "fswatch",
    "entr",
    "mongostat",
    "mongotop",
]);

/** 裸命令进 REPL 的解释器：是否结束取决于有没有脚本/内联代码参数，见 isReplWithoutScript */
const INTERPRETER_COMMANDS = new Set([
    "python",
    "python2",
    "python3",
    "pypy",
    "pypy3",
    "node",
    "nodejs",
    "deno",
    "bun",
    "ruby",
    "perl",
    "php",
    "lua",
    "lua5.1",
    "lua5.2",
    "lua5.3",
    "lua5.4",
    "luajit",
    "r",
    "julia",
    "octave",
    "octave-cli",
    "gnuplot",
    "bc",
    "dc",
    "sqlite3",
]);

/** 解释器「带值选项」：其后的 token 是选项值而不是脚本路径 */
const INTERPRETER_OPTS_WITH_VALUE = new Set([
    "-W",
    "-X",
    "-l",
    "-L",
    "-I",
    "-C",
    "-D",
    "-U",
    "-O",
    "--require",
    "--loader",
    "--include",
    "--include-path",
    "--inspect",
    "--inspect-brk",
    "--max-old-space-size",
    "--seed",
    "--home",
]);

/** 包装命令：真正的主命令在其参数里，需要跳过（与 commandStatus.ts 同规则） */
const WRAPPER_COMMANDS = new Set([
    "sudo",
    "doas",
    "nohup",
    "env",
    "command",
    "builtin",
    "time",
    "timeout",
    "strace",
    "ltrace",
    "nice",
    "ionice",
    "taskset",
    "chrt",
    "setsid",
    "stdbuf",
]);

/** 包装命令中带值的选项：跳过选项本身后还要再跳过它的值（与 commandStatus.ts 同规则） */
const WRAPPER_OPTS_WITH_VALUE = new Set([
    "-u",
    "-g",
    "-h",
    "-p",
    "-c",
    "-C",
    "-T",
    "-U",
    "-r",
    "-t",
    "-D",
    "-R", // sudo
    "-n",
    "-d",
    "-o",
    "-f",
    "-e",
    "-a",
    "-w",
    "-s", // nice/strace 等
    "--user",
    "--group",
    "--host",
    "--prompt",
    "--chdir",
    "--role",
    "--type",
    "--signal",
    "--kill-after",
    "--preserve-env",
    "--cpu",
    "--delay",
    "--output",
    "--file",
]);

/**
 * 解析主命令：只取第一个管道/连接符/重定向之前的片段，
 * 跳过行首环境变量赋值（LANG=C ls）和包装命令及其选项（sudo -u root xxx / timeout 30 xxx）。
 * 与 commandStatus.ts 的 extractMainCommand 同规则，这里额外返回主命令后的参数供驻留判定使用。
 */
function parseMainCommand(command: string): { name: string; args: string[] } {
    const firstSegment = command.split(/\|\||&&|[|;>]/)[0] ?? command;
    const tokens = firstSegment.trim().split(/\s+/);
    let i = 0;
    while (i < tokens.length && /^\w+=\S*$/.test(tokens[i])) i++;
    while (i < tokens.length) {
        const name = tokens[i].split("/").pop() ?? "";
        if (!WRAPPER_COMMANDS.has(name)) break;
        i++;
        while (i < tokens.length) {
            const token = tokens[i];
            if (WRAPPER_OPTS_WITH_VALUE.has(token)) {
                i += 2; // 选项 + 值
            } else if (/^-/.test(token) || /^\d+(?:\.\d+)?$/.test(token)) {
                i++;
            } else {
                break;
            }
        }
    }
    const mainToken = tokens[i] ?? "";
    return {
        name: (mainToken.split("/").pop() ?? "").toLowerCase(),
        args: tokens.slice(i + 1),
    };
}

/** -f/-F/--follow 跟随参数（tail、docker logs、kubectl logs 通用），允许 -qf 这类合并写法 */
function hasFollowFlag(args: string[]): boolean {
    return args.some((t) => t === "-f" || t === "-F" || t.startsWith("--follow") || /^-[a-zA-Z]*[fF]\d*$/.test(t));
}

/** -i 和 -t 同时出现（docker exec -it、kubectl exec --stdin --tty），组合或分开写都算 */
function hasInteractiveTty(args: string[]): boolean {
    const hasI = args.some((t) => /^-[a-zA-Z]*i[a-zA-Z]*$/.test(t)) || args.includes("--stdin");
    const hasT = args.some((t) => /^-[a-zA-Z]*t[a-zA-Z]*$/.test(t)) || args.includes("--tty");
    return hasI && hasT;
}

/**
 * 解释器是否「裸进 REPL」：有脚本路径或内联代码（-c/-e/-m 等）的跑完即退出；
 * 没有可执行内容的裸命令（python、node、sqlite3 db）会停在交互提示符，视为常驻。
 */
function isReplWithoutScript(cmdName: string, args: string[]): boolean {
    // 内联代码/模块执行：跑完即退出，不算 REPL（-r 对 php 是内联代码，对 node 是预载模块，分开处理）
    const codeOpts =
        cmdName === "php" ? ["-c", "-e", "-E", "-m", "-p", "-r", "--eval", "--print"] : ["-c", "-e", "-E", "-m", "-p", "--eval", "--print"];
    if (args.some((t) => codeOpts.includes(t) || /^-[eE]\S/.test(t))) return false;
    // -i/--interactive / php -a：就算有脚本，跑完也会停在 REPL
    if (args.some((t) => t === "-i" || t === "--interactive" || (t === "-a" && cmdName === "php"))) return true;
    // php -S：内置 web 服务器，常驻
    if (cmdName === "php" && args.some((t) => t.startsWith("-S"))) return true;
    // 找第一个非选项且不是选项值的 token：存在则视为脚本路径
    for (let i = 0; i < args.length; i++) {
        const token = args[i];
        if (token.startsWith("-")) continue;
        if (i > 0 && INTERPRETER_OPTS_WITH_VALUE.has(args[i - 1])) continue;
        // sqlite3 的第一个非选项参数是数据库文件（进 REPL），第二个才是 SQL（跑完退出）
        if (cmdName === "sqlite3") {
            return !args.slice(i + 1).some((t) => !t.startsWith("-"));
        }
        return false;
    }
    return true;
}

/**
 * 按「命令名 + 参数」判定常驻/交互命令。
 * 常驻命令回不到 shell 提示符，提示符判定对它们无效，直接判未结束交外层超时兜底。
 */
function isResidentByArgs(cmdName: string, args: string[]): boolean {
    // 非选项参数集合：docker/kubectl 这类多级子命令直接在参数里找子命令词，忽略选项层级
    const subs = args.filter((t) => !t.startsWith("-"));
    switch (cmdName) {
        // ---- 网络探测 ----
        // ping 族：无次数（-c）或总时长（-w/--timeout/--deadline）限制会一直 ping
        case "ping":
        case "ping6":
        case "hping3":
        case "nping":
        case "fping":
            return !args.some(
                (t) =>
                    t === "-c" ||
                    t === "-w" ||
                    /^-[cw]\d/.test(t) ||
                    t.startsWith("--count") ||
                    t.startsWith("--timeout") ||
                    t.startsWith("--deadline"),
            );
        // mtr：无 --report 参数时是 GTK/curses 全屏界面
        case "mtr":
            return !args.some((t) => ["-r", "--report", "-c", "--report-cycles", "-w", "--report-wide"].includes(t) || /^-c\d/.test(t));
        // tcpdump 族：无 -c 抓包次数限制会一直抓（-r 读 pcap 文件是一次性的）
        case "tcpdump":
        case "tshark":
        case "dumpcap":
        case "ngrep":
        case "tcpflow":
        case "netsniff-ng":
            return !args.some((t) => t === "-c" || /^-c\d/.test(t) || t === "-r" || t.startsWith("-r") || t.startsWith("--count"));

        // ---- 日志/输出跟随 ----
        case "tail":
            return hasFollowFlag(args);
        case "dmesg":
            return args.some((t) => ["-w", "-W", "--follow", "--follow-new"].includes(t));
        // journalctl：默认进 pager（less），-f 是持续跟随，只有 --no-pager/-n 截断输出才一次性退出
        case "journalctl":
            return !args.some((t) => t === "--no-pager" || t === "-n" || t.startsWith("--lines"));
        // systemctl：裸命令和 list-* 子命令是长列表走 pager；status/start/stop 等输出短直接退出
        case "systemctl": {
            const sub = subs[0];
            if (!sub) return true;
            return sub.startsWith("list");
        }

        // ---- 容器 / k8s ----
        case "docker":
        case "podman":
        case "nerdctl": {
            if (subs.some((t) => ["attach", "stats", "events", "wait"].includes(t))) return true;
            if (subs.includes("logs")) return hasFollowFlag(args);
            // exec/run -it 进容器 shell；start -ai 重新附着到容器进程
            if (subs.some((t) => ["exec", "run"].includes(t)) && hasInteractiveTty(args)) return true;
            if (subs.includes("start") && (hasInteractiveTty(args) || args.includes("-a") || args.includes("--attach"))) return true;
            // compose：up 不带 -d 前台跟随日志；logs -f 跟随；attach/watch/events 常驻
            if (subs.includes("up")) return !args.includes("-d") && !args.includes("--detach");
            if (subs.some((t) => ["watch"].includes(t))) return true;
            return false;
        }
        case "kubectl":
        case "oc": {
            if (subs.includes("logs")) return hasFollowFlag(args);
            if (subs.includes("exec")) return hasInteractiveTty(args);
            if (subs.some((t) => ["attach", "port-forward", "proxy"].includes(t))) return true;
            if (subs.includes("get")) return args.some((t) => t === "-w" || t === "--watch" || t === "--watch=true");
            return false;
        }

        // ---- 采样监控：vmstat 1 只有间隔没有次数会一直刷，vmstat 1 5 采 5 次自动退出 ----
        case "vmstat":
        case "iostat":
        case "mpstat":
        case "pidstat":
        case "sar":
        case "dstat":
        case "ifstat":
        case "nfsiostat":
        case "cifsiostat":
            return subs.filter((t) => /^\d+(?:\.\d+)?$/.test(t)).length === 1;
        // top 默认全屏常驻，-b 批处理模式一次性输出
        case "top":
            return !args.includes("-b");
        // netstat -c 持续刷新
        case "netstat":
            return args.includes("-c");
        case "udevadm":
            return subs.includes("monitor");
        // inotifywait/inotifywatch：无 -t 超时会一直等文件事件
        case "inotifywait":
        case "inotifywatch":
            return !args.some((t) => t === "-t" || t.startsWith("--timeout"));

        // ---- 子 shell / 提权 ----
        // su 不带 -c 进入目标用户的交互 shell
        case "su":
            return !args.includes("-c") && !args.some((t) => t.startsWith("--command"));
        // sudo -i/-s 进 root shell；sudo cmd 跑完即退出
        case "sudo":
            return args.some((t) => ["-i", "-s", "--login", "--shell"].includes(t));
        // 裸 shell 命令进子 shell；带 -c 跑完即退出
        case "bash":
        case "sh":
        case "zsh":
        case "fish":
        case "ksh":
        case "csh":
        case "tcsh":
        case "dash":
        case "ash":
            return !args.includes("-c");

        // ---- 终端复用 ----
        case "tmux": {
            // 带值选项（-L socket、-S 路径等）其后的 token 不是子命令
            const TMUX_OPTS_WITH_VALUE = new Set(["-L", "-S", "-f", "-t", "-c", "-x", "-y"]);
            let sub = "";
            for (let i = 0; i < args.length; i++) {
                if (TMUX_OPTS_WITH_VALUE.has(args[i])) {
                    i++;
                    continue;
                }
                if (!args[i].startsWith("-")) {
                    sub = args[i];
                    break;
                }
            }
            if (!sub) return true; // 裸 tmux = 新建会话并附着
            // new -d 后台建会话不占用终端；attach/new 不带 -d 进入会话界面
            if (["new", "new-session"].includes(sub)) return !args.includes("-d");
            return ["attach", "attach-session", "att", "a"].includes(sub);
        }
        case "screen": {
            // 查询/管理类参数一次性退出
            if (args.some((t) => ["-ls", "-list", "-wipe", "-X", "-q", "-v", "--version"].includes(t))) return false;
            // -dm/-Dm 后台起会话；-d/-D 单独使用是分离别人的会话，都不占用终端
            if (args.some((t) => /^-[dD]m/i.test(t) || /^-m[dD]/.test(t))) return false;
            if (args.some((t) => ["-d", "-D"].includes(t))) return false;
            // 裸 screen、screen -r/-x、screen cmd 都会占用终端进入会话
            return true;
        }

        // ---- 磁盘/计划任务交互 ----
        // fdisk 无 -l 进入交互分区界面
        case "fdisk":
            return !args.some((t) => t === "-l" || t.startsWith("--list"));
        // cfdisk/cgdisk 是全屏界面
        case "cfdisk":
        case "cgdisk":
            return true;
        // parted 无 -s/-l/print 等参数进入交互模式
        case "parted":
            return !args.some((t) => ["-l", "-s", "-m", "--list", "--script", "--machine"].includes(t) || ["print", "help"].includes(t));
        case "crontab":
            return args.includes("-e");
        // at/batch 无 -f 从 stdin 读任务，等人输入
        case "at":
        case "batch":
            if (args.some((t) => ["-l", "-r", "-d"].includes(t))) return false;
            return !args.includes("-f");

        // ---- 服务/进程管理 ----
        case "pm2":
            return subs.some((t) => ["logs", "monit"].includes(t));
        case "supervisorctl": {
            // 裸命令进交互 shell；tail -f 持续跟随；其余子命令一次性
            if (subs.includes("tail")) return hasFollowFlag(args);
            const oneshot = [
                "status",
                "start",
                "stop",
                "restart",
                "reread",
                "update",
                "add",
                "remove",
                "clear",
                "signal",
                "pid",
                "reload",
                "shutdown",
                "avail",
                "maintail",
                "fg",
                "version",
            ];
            return !subs.some((t) => oneshot.includes(t));
        }

        // ---- 其它 ----
        // openssl s_client/s_server 连接后进入交互会话
        case "openssl":
            return subs.some((t) => ["s_client", "s_server"].includes(t));
        // sleep infinity 永不退出
        case "sleep":
            return args.some((t) => /^(?:infinity|inf)$/i.test(t));
        default:
            // 解释器族：裸命令进 REPL 的视为常驻
            if (INTERPRETER_COMMANDS.has(cmdName)) return isReplWithoutScript(cmdName, args);
            return false;
    }
}

/**
 * 判断本轮终端观察是否可以停止。
 * true 包含命令结束、等待输入、进入交互提示符和会话退出，不代表进程一定已经退出。
 */
export function parseCommandResultShouldStopWatching(command: string, result: string): boolean {
    // 快照为空说明连命令回显都还没渲染出来，无从判断
    if (!result || !result.trim()) return false;
    // 终端快照带 ANSI 颜色码和 \r，先剥离避免干扰匹配
    const text = result.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07/g, "").replace(/\r/g, "");
    const lines = text.split("\n");

    // 终端状态主要看最后一个非空行：提示符表示已进入下一次交互，普通输出表示仍需观察。
    let lastLine = "";
    let nonEmptyCount = 0;
    // 尾部非空行（最多 3 行）：会话终止特征不一定在最后一行，
    // 比如 ssh 退出时 "Connection to host closed." 后面还会跟一行本地提示符
    const tailLines: string[] = [];
    for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].trim()) continue;
        nonEmptyCount++;
        lastLine = lastLine || lines[i].trimEnd();
        if (tailLines.length < 3) tailLines.unshift(lines[i].trimEnd());
    }
    if (!lastLine) return false;

    // 快照只有一行且包含命令尾巴 → 还是命令回显阶段（命令自身还没产生任何输出），
    // 防止 `echo hi #` 这类以提示符字符结尾的命令把回显行误判成新提示符
    const cmdTail = (command.trimEnd().split("\n").pop() ?? "").slice(-24);
    if (nonEmptyCount === 1 && cmdTail.length >= 2 && lastLine.includes(cmdTail)) return false;

    const { name, args } = parseMainCommand(command);

    // 第一层：密码、确认、分页器和 REPL 都已经进入下一次交互，立即把快照交还上层。
    if (WAITING_INPUT_PATTERNS.some((pattern) => pattern.test(lastLine))) return true;
    if (INTERACTIVE_PROMPT_PATTERNS.some((pattern) => pattern.test(lastLine))) return true;

    const shellPromptReady = SHELL_PROMPT_PATTERNS.some((pattern) => pattern.test(lastLine));
    // 第二层：远程会话的远端提示符与本地提示符都表示无需继续等待；会话终止也直接停止观察。
    if (REMOTE_SESSION_COMMANDS.has(name)) {
        return shellPromptReady || SESSION_END_PATTERNS.some((pattern) => tailLines.some((line) => pattern.test(line)));
    }

    // 第三层：出现 Shell 提示符时，即使原命令被归为常驻程序，也说明它已经退出并交还终端。
    // 这项检查必须早于常驻判定，否则 mysql -e、超时包装命令等一次性用法会一直等待。
    if (shellPromptReady) return true;

    // 第四层：仍在持续输出且没有任何输入提示的常驻命令，需要继续观察。
    if (RESIDENT_COMMANDS.has(name) || isResidentByArgs(name, args)) return false;

    // 第五层：exit/logout 等终止特征。放在常驻判定之后，避免 tail -f 的日志内容误触发。
    if (SESSION_END_PATTERNS.some((pattern) => pattern.test(lastLine))) return true;
    return false;
}
