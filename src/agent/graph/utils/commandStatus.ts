// ===================== 命令执行结果成败判断 =====================
// 思路说明：
// 1. exec_cmd 只回传 stdout（stderr 在 ssh.rs 中被丢弃），visual 终端快照则包含全部输出，
//    没有退出码可用，因此只能基于输出文本做「高置信错误特征」匹配：命中 → error，否则 → success。
// 2. grep/cat/tail/dmesg/journalctl 等「内容类命令」的输出主体是文件/日志内容，
//    里面天然带有 error、failed、No such file 等字样，这类命令只认「命令名: 」开头的自身报错，
//    避免把日志内容误判成执行失败。
// 3. 非内容类命令按五层判断：shell 级错误 → 「命令名: 错误关键词」行 → errno 行尾 → usage 行 → 命令特定错误表。

/** 内容类命令：输出主体是文件/日志/差异内容，不能用通用错误模式判断，只认自身报错 */
const CONTENT_COMMANDS = new Set([
    "cat",
    "grep",
    "egrep",
    "fgrep",
    "zgrep",
    "rg",
    "tail",
    "head",
    "less",
    "more",
    "awk",
    "sed",
    "jq",
    "cut",
    "sort",
    "uniq",
    "tr",
    "strings",
    "column",
    "bat",
    "dmesg",
    "journalctl",
    "last",
    "lastlog",
    "lastb",
    "diff",
    "od",
    "xxd",
    "hexdump",
    "nl",
    "paste",
    "comm",
    "iconv",
    "fmt",
    "fold",
]);

/** GNU 工具错误格式为 `cmd: 操作对象: 系统错误`，errno 描述固定在行尾 */
const ERRNO_TAIL =
    /(?:No such file or directory|Permission denied|Operation not permitted|Is a directory|Not a directory|Read-only file system|No space left on device|Disk quota exceeded|Too many open files|Argument list too long|Input\/output error|Cannot allocate memory|Device or resource busy|Directory not empty|No such process|No such device|Connection refused|Connection timed out|Network is unreachable|No route to host|Name or service not known|File exists|Invalid argument|Too many levels of symbolic links|Broken pipe|Access denied)\s*$/i;

/** shell/解释器级错误：任何命令都可能直接抛出，且几乎不会出现在正常输出里 */
const SHELL_ERROR_PATTERNS: RegExp[] = [
    /command not found/i,
    // bash: cd: xxx / sh: line 1: xxx / zsh: xxx / -bash: xxx（登录 shell）
    /^-?(?:bash|sh|zsh|dash|ash|ksh|fish)(?:\[\d+\])?\s*:\s*(?:line\s*\d+\s*:\s*)?/im,
    /syntax error near unexpected token/i,
    /Traceback \(most recent call last\)/,
    /Segmentation fault/i,
    /core dumped/i,
    /^Killed\s*$/im, // OOM killer
    /error while loading shared libraries/i,
    /cannot execute binary file/i,
    /bad interpreter/i,
    /No space left on device/i,
    /Read-only file system/i,
    /Disk quota exceeded/i,
    /npm ERR!/,
    /Exception in thread "/,
    /BUILD FAILURE/,
    /\[\s*FAILED\s*\]/, // sysv 服务启动失败
    /Try '[^']+ --help' for (?:more information|help)/i, // GNU 参数错误后的固定提示
    /Permission denied \(publickey/i,
    /is not in the sudoers file/i,
    /sorry, you must have a tty/i,
    /a password is required/i,
];

/**
 * 通用「命令名: 错误消息」行首格式。
 * 要求行首是命令名（避开带时间戳的日志行），消息部分以典型错误关键词开头；
 * 中间的 `(?:.*:\s*)?` 兼容 `kill: (123): No such process` 这类带参数段的格式。
 */
const CMD_PREFIX_ERROR =
    /^[\w./-]+(?:\([^)]*\))?\s*:\s*(?:.*:\s*)?(?:cannot\b|can't\b|unable to\b|invalid\b|unrecognized option|illegal option|missing (?:operand|argument)|too (?:many|few) arguments|not a valid\b|failed\b|error\b|no such\b|permission denied|operation not permitted|read-only\b)/im;

/** 参数错误时打印的 usage 行；--help/-h/man 场景会排除 */
const USAGE_LINE = /^(?:[Uu]sage|用法)\s*[:：]/m;

/** 命令特定错误模式表：key 为主命令名（basename），value 为该命令特有的失败特征 */
const COMMAND_ERROR_PATTERNS: Record<string, RegExp[]> = {
    // ---- systemd / sysv 服务 ----
    systemctl: [
        /Failed to .+/i,
        /Unit .+ (?:not found|could not be found)/i,
        /Unknown operation/i,
        /Active:\s+failed\b/i, // status 查到 failed 状态（inactive 不算，未启动是正常查询结果）
        /^systemctl:\s*/im,
    ],
    service: [/unrecognized service/i, /\[\s*FAILED\s*\]/i],
    hostnamectl: [/Failed to/i],
    timedatectl: [/Failed to/i],
    localectl: [/Failed to/i],
    // ---- 网络 ----
    ping: [/unknown host/i, /Name or service not known/i, /100(?:\.0)?% packet loss/i, /Destination (?:Host|Net) Unreachable/i],
    curl: [/curl: \(\d+\)/],
    wget: [/^wget: /im, /ERROR \d{3}/, /failed: [A-Z]/],
    ssh: [
        /Permission denied/i,
        /Connection (?:refused|timed out)/i,
        /No route to host/i,
        /Could not resolve hostname/i,
        /Host key verification failed/i,
    ],
    scp: [/Permission denied/i, /Connection (?:refused|timed out)/i, /not a regular file/i, /No such file or directory/i],
    sftp: [/Permission denied/i, /Connection (?:refused|timed out)/i, /Could not resolve hostname/i],
    rsync: [/rsync error:/i, /^rsync: /im],
    nc: [/Connection refused/i, /Connection timed out/i, /Name or service not known/i],
    ncat: [/Connection refused/i, /Connection timed out/i, /Name or service not known/i],
    telnet: [/Connection refused/i, /Connection timed out/i, /Name or service not known/i],
    dig: [/connection timed out/i, /no servers could be reached/i],
    nslookup: [/connection timed out/i, /no servers could be reached/i, /server can't find/i],
    host: [/connection timed out/i, /no servers could be reached/i, /not found: \d+\(NXDOMAIN\)/i],
    ip: [/Cannot find device/i, /Command "[^"]+" is unknown/i, /does not exist/i, /^Error: /im],
    ifconfig: [/error fetching interface information/i, /Device not found/i],
    ethtool: [/Cannot get .+/i, /No such device/i, /^ethtool: /im],
    iptables: [/^ip6?tables[^:]*: /im],
    ip6tables: [/^ip6?tables[^:]*: /im],
    "firewall-cmd": [/^Error/im, /FAILED/, /INVALID_/],
    // ---- 包管理 ----
    apt: [/^E: /m, /Unable to locate package/i, /has no installation candidate/i, /Could not get lock/i],
    "apt-get": [/^E: /m, /Unable to locate package/i, /has no installation candidate/i, /Could not get lock/i],
    dpkg: [/^dpkg: error/im, /dependency problems/i],
    yum: [/No match for argument/i, /No package .+ available/i, /^Error:/m, /Could not retrieve mirrorlist/i],
    dnf: [/No match for argument/i, /No package .+ available/i, /^Error:/m, /Could not retrieve mirrorlist/i],
    rpm: [/^error: /im],
    snap: [/^error: /im],
    flatpak: [/^error: /im],
    pip: [/^ERROR: /m],
    pip3: [/^ERROR: /m],
    // ---- 容器 / k8s ----
    docker: [
        /Error response from daemon/i,
        /Cannot connect to the Docker daemon/i,
        /^docker: Error/im,
        /manifest unknown/i,
        /permission denied while trying to connect/i,
    ],
    podman: [/Error response from daemon/i, /Cannot connect to the .* daemon/i, /^podman: Error/im],
    kubectl: [/Error from server/i, /was refused - did you specify/i, /^error: /im],
    helm: [/^Error:/m],
    // ---- 编译 / 构建 ----
    make: [/\*\*\* .+Error/i, /No rule to make target/i],
    gcc: [/: error:/, /undefined reference/i, /fatal error:/i],
    "g++": [/: error:/, /undefined reference/i, /fatal error:/i],
    cc: [/: error:/, /undefined reference/i, /fatal error:/i],
    clang: [/: error:/, /undefined reference/i, /fatal error:/i],
    go: [/cannot find package/i, /^undefined: /im],
    cargo: [/^error(?:\[E\d+\])?: /im],
    mvn: [/BUILD FAILURE/i],
    mvnw: [/BUILD FAILURE/i],
    gradle: [/FAILURE: Build failed/i],
    gradlew: [/FAILURE: Build failed/i],
    // ---- 解释器 / 运行时 ----
    python: [/Traceback \(most recent call last\)/],
    python3: [/Traceback \(most recent call last\)/],
    node: [/(?:Error|TypeError|ReferenceError|SyntaxError|RangeError): [^\n]*\n\s+at /, /node:internal\/errors/],
    npm: [/npm ERR!/],
    yarn: [/error Command failed/i],
    pnpm: [/ERR_PNPM_/],
    java: [/Exception in thread "/],
    php: [/PHP (?:Fatal|Parse) error/i],
    perl: [/Can't locate .+ in @INC/i],
    ruby: [/\(LoadError\)/],
    // ---- 数据库 ----
    mysql: [/^ERROR \d+/m],
    mysqldump: [/^ERROR \d+/m],
    psql: [/^ERROR: /m, /^psql: error:/im],
    "redis-cli": [/^\(error\)/im, /Could not connect to Redis/i],
    mongo: [/Mongo(?:Server)?Error/i],
    mongosh: [/Mongo(?:Server)?Error/i],
    // ---- 版本控制 ----
    git: [/^fatal: /im, /^error: /im],
    // ---- 压缩 / 归档 ----
    tar: [/^tar: .*(?:Cannot|Error|Refusing)/im, /Error is not recoverable/i],
    unzip: [/^unzip: /im, /cannot find zipfile directory/i],
    zip: [/^zip error: /im],
    gzip: [/^gzip: .*(?:unexpected end|not in gzip format|No such)/im],
    gunzip: [/^gzip: .*(?:unexpected end|not in gzip format|No such)/im],
    bzip2: [/^bzip2: /im],
    xz: [/^xz: /im],
    // ---- 用户 / 权限 ----
    useradd: [/^useradd: /im],
    userdel: [/^userdel: /im],
    usermod: [/^usermod: /im],
    groupadd: [/^groupadd: /im],
    groupdel: [/^groupdel: /im],
    passwd: [/Authentication token manipulation error/i, /^passwd: /im],
    su: [/Authentication failure/i, /^su: /im],
    sudo: [/sorry, you must have a tty/i, /a password is required/i, /not in the sudoers file/i],
    chown: [/^chown: /im],
    chmod: [/^chmod: /im],
    chattr: [/^chattr: /im],
    // ---- 进程管理 ----
    kill: [/No such process/i, /^kill: /im],
    killall: [/no process (?:found|killed)/i],
    pkill: [/^pkill: /im],
    nohup: [/^nohup: (?:cannot|failed)/im],
    jobs: [/no such job/i],
    bg: [/no such job/i],
    fg: [/no such job/i],
    // ---- 磁盘 / 挂载 ----
    mount: [/^mount: /im, /must be superuser/i],
    umount: [/^umount: /im, /target is busy/i],
    fdisk: [/^fdisk: /im],
    mkfs: [/^mkfs[.\w]*: /im],
    fsck: [/^fsck[.\w]*: /im],
    dd: [/^dd: /im],
    du: [/^du: /im],
    df: [/^df: /im],
    lsblk: [/^lsblk: /im],
    // ---- 文件操作（通用模式大多已覆盖，这里冗余保险） ----
    ln: [/^ln: /im],
    mkdir: [/^mkdir: /im],
    rmdir: [/^rmdir: /im],
    touch: [/^touch: /im],
    stat: [/^stat: /im],
    xargs: [/^xargs: /im],
    tee: [/^tee: /im],
    install: [/^install: /im],
    lsof: [/^lsof: /im],
    ps: [/^ps: /im],
    sleep: [/^sleep: /im],
    // ---- 计划任务 ----
    crontab: [/errors in crontab file/i, /^crontab: /im],
    at: [/^at: /im],
    // ---- web 服务器 ----
    nginx: [/\[emerg\]/, /test failed/i, /^nginx: /im],
    apachectl: [/Syntax error on line/i, /^AH\d+: /m],
    httpd: [/Syntax error on line/i, /^AH\d+: /m],
    // ---- 抓包 ----
    tcpdump: [/^tcpdump: /im],
    tshark: [/^tshark: /im],
    // ---- 云 CLI / 编排 ----
    aws: [/^aws: error:/im, /An error occurred \(.+\) when calling/i],
    gcloud: [/^ERROR: /m],
    az: [/^ERROR: /m],
    ansible: [/FAILED!/],
    "ansible-playbook": [/FAILED!/, /^fatal: /im],
    terraform: [/^Error: /m],
    // ---- 其它 ----
    openssl: [/^\d+:error:/m, /^error: /im],
    "update-alternatives": [/^update-alternatives: error/im],
    setenforce: [/^setenforce: /im],
    semanage: [/^semanage: /im],
    reboot: [/Failed to/i, /must be superuser/i],
    shutdown: [/Failed to/i, /must be superuser/i],
    poweroff: [/Failed to/i, /must be superuser/i],
    halt: [/Failed to/i, /must be superuser/i],
};

/** 包装命令：真正的主命令在其参数里，需要跳过（sudo -u root ls → ls） */
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

/** 包装命令中带值的选项：跳过选项本身后还要再跳过它的值（sudo -u root 中的 root） */
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

/** 从命令行中提取主命令名：跳过环境变量赋值、包装命令及其选项，取 basename */
function extractMainCommand(command: string): string {
    // 只取第一个管道/连接符/重定向之前的片段，主命令一定在这里
    const firstSegment = command.split(/\|\||&&|[|;>]/)[0] ?? command;
    const tokens = firstSegment.trim().split(/\s+/);
    let i = 0;
    // 跳过行首环境变量赋值，如 LANG=C ls
    while (i < tokens.length && /^\w+=\S*$/.test(tokens[i])) i++;
    // 跳过包装命令及其选项（sudo -u root xxx / timeout 30 xxx）
    while (i < tokens.length) {
        const name = tokens[i].split("/").pop() ?? "";
        if (!WRAPPER_COMMANDS.has(name)) break;
        i++;
        // 跳过包装命令的选项：带值选项连值一起跳，纯数字参数（timeout 30）也跳过
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
    return (mainToken.split("/").pop() ?? "").toLowerCase();
}

/** 是否是查帮助场景：--help/-h/man/help 打印的 usage 不算参数错误 */
function isHelpCommand(command: string): boolean {
    return /(^|\s)--help(\s|$)/.test(command) || /(^|\s)-h(\s|$)/.test(command) || /^\s*(?:help|man|info)\b/.test(command);
}

/**
 * 内容类命令的自身报错判断：只认 `命令名: ` 开头的行，
 * 且行内需带错误关键词或以 errno 短语结尾（排除 tail 的 inotify 警告这类非错误提示）。
 */
function isContentCommandError(cmdName: string, text: string): boolean {
    const selfPrefix = new RegExp(`^${cmdName}(?:\\s*\\([^)]*\\))?\\s*:\\s*`, "i");
    const errorKeyword =
        /cannot\b|can't\b|failed\b|error\b|syntax error|parse error|unknown command|unexpected|unterminated|division by zero|invalid\b|no such\b|permission denied|operation not permitted|exhausted|not recognized/i;
    for (const line of text.split("\n")) {
        if (!selfPrefix.test(line)) continue;
        if (ERRNO_TAIL.test(line) || errorKeyword.test(line)) return true;
    }
    return false;
}

// 判断命令执行的结果是否成功
export function parseCommandResultIsSuccess(command: string, result: string): "success" | "error" {
    if (!result || !result.trim()) return "success"; // 无输出无从判断，按成功处理（rm -f/mkdir -p 等成功本就无输出）
    // 终端快照带 ANSI 颜色码和 \r，先剥离避免干扰匹配
    const text = result.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07/g, "").replace(/\r/g, "");
    const cmdName = extractMainCommand(command);

    // 内容类命令：输出主体是文件/日志内容，只认自身报错，其余一律视为成功
    if (CONTENT_COMMANDS.has(cmdName)) {
        return isContentCommandError(cmdName, text) ? "error" : "success";
    }

    // 第一层：shell/解释器级错误（command not found、bash: 前缀、Traceback 等）
    for (const pattern of SHELL_ERROR_PATTERNS) {
        if (pattern.test(text)) return "error";
    }
    // 第二层：通用「命令名: 错误消息」格式（ls: cannot access ... 等）
    if (CMD_PREFIX_ERROR.test(text)) return "error";
    // 第三层：行首是「命令名:」且行尾是 errno 描述（find: '/x': No such file or directory 等）
    for (const line of text.split("\n")) {
        if (/^[\w./-]+(?:\([^)]*\))?\s*:/.test(line) && ERRNO_TAIL.test(line)) return "error";
    }
    // 第四层：usage 行首视为参数错误（--help/-h/man 场景除外）
    if (USAGE_LINE.test(text) && !isHelpCommand(command)) return "error";
    // 第五层：命令特定错误表
    const specificPatterns = COMMAND_ERROR_PATTERNS[cmdName];
    if (specificPatterns?.some((pattern) => pattern.test(text))) return "error";
    return "success";
}
