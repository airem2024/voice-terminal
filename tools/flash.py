# flash.py — 串口整片刷机。两个方向都能走,刷过去还能刷回来。
#
#   python flash.py stock     刷微雪官方出厂固件(Brookesia 启动器,含小智AI)
#   python flash.py xixi      刷回语音终端 v2.4.11
#   python flash.py stock --port COM5      指定串口(不给就自动找)
#
# 为什么不能走 OTA:板子的 OTA 通道只写 app 分区(0x20000),bootloader/分区表/assets 都够不着。
# 换官方固件是整片烧 0x0,只能串口来。
#
# 需要:pyserial(刷过 esptool 就有) + requests + esptool。缺 esptool 时脚本会告诉你怎么装。
# ⚠️ 跑之前先把 serial-relay.py 那个窗口 Ctrl+C 关掉——串口同一时间只能被一个程序占着。
import argparse
import hashlib
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "fw_cache")


def load_conf():
    """网关地址和 token 不写在代码里 —— 这个脚本跑在你自己的电脑上,而 token 能刷固件。
    按顺序找:环境变量 GW_BASE/GW_TOKEN → 本目录的 gateway.env(两行 BASE=… / TOKEN=…,不进仓库)。"""
    conf = {}
    path = os.path.join(HERE, "gateway.env")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    conf[k.strip()] = v.strip()
    base = (os.environ.get("GW_BASE") or conf.get("BASE") or "").rstrip("/")
    token = os.environ.get("GW_TOKEN") or conf.get("TOKEN") or ""
    if not base or not token:
        sys.exit(
            "还没配网关地址。在 %s 里写两行:\n"
            "  BASE=https://你的网关域名\n"
            "  TOKEN=你的 boardToken(网关 config.json 里那个)\n"
            "或者设环境变量 GW_BASE / GW_TOKEN。" % path
        )
    return base, token


BASE, TOKEN = load_conf()

try:
    import requests
except ImportError:
    sys.exit("缺 requests:  pip install requests")


def human(n):
    return f"{n / 1048576:.1f}MB" if n >= 1048576 else f"{n / 1024:.0f}KB"


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for blk in iter(lambda: f.read(1 << 20), b""):
            h.update(blk)
    return h.hexdigest()


def fetch(name, size, sha, tries=6):
    """下载一个固件文件,支持断点续传。跨境链路一抖就断,这里断了从断点接着下,不从头来。"""
    os.makedirs(CACHE, exist_ok=True)
    dest = os.path.join(CACHE, name)

    if os.path.exists(dest) and os.path.getsize(dest) == size:
        if sha256_of(dest) == sha:
            print(f"  {name}  已有且校验通过,跳过下载")
            return dest
        print(f"  {name}  本地文件校验不过,重新下载")
        os.remove(dest)

    url = f"{BASE}/fw/file/{name}"
    for attempt in range(1, tries + 1):
        have = os.path.getsize(dest) if os.path.exists(dest) else 0
        if have > size:  # 本地比远端还大 = 是残留的旧版本,重来
            os.remove(dest)
            have = 0
        if have == size:
            break
        headers = {"X-Token": TOKEN}
        if have:
            headers["Range"] = f"bytes={have}-"
            print(f"  {name}  从 {human(have)} 续传 (第 {attempt} 次)")
        else:
            print(f"  {name}  开始下载 {human(size)}")
        try:
            r = requests.get(url, headers=headers, stream=True, timeout=30)
            if r.status_code not in (200, 206):
                sys.exit(f"下载失败 HTTP {r.status_code} — {name}")
            # 服务器忽略了 Range(回 200)就得从头写,否则会把整包续在残段后面。
            mode = "ab" if (have and r.status_code == 206) else "wb"
            if mode == "wb":
                have = 0
            t0, last = time.time(), 0.0
            with open(dest, mode) as f:
                for chunk in r.iter_content(65536):
                    if not chunk:
                        continue
                    f.write(chunk)
                    have += len(chunk)
                    now = time.time()
                    if now - last > 0.5:
                        spd = have / max(now - t0, 0.01) / 1024
                        pct = have * 100 // size
                        sys.stdout.write(f"\r    {pct:3d}%  {human(have)}/{human(size)}  {spd:.0f}KB/s   ")
                        sys.stdout.flush()
                        last = now
            print()
        except Exception as e:
            print(f"\n    断了({e}),{human(os.path.getsize(dest) if os.path.exists(dest) else 0)} 已存,重试…")
            time.sleep(2)
            continue
        if os.path.getsize(dest) >= size:
            break
    else:
        sys.exit(f"{name} 下了 {tries} 次都没下完,先检查网络")

    got = sha256_of(dest)
    if got != sha:
        os.remove(dest)
        sys.exit(f"{name} 校验不匹配(期望 {sha[:12]}… 实得 {got[:12]}…),已删除,重跑一次")
    print(f"  {name}  校验通过")
    return dest


def find_port():
    from serial.tools import list_ports

    ports = list(list_ports.comports())
    if not ports:
        sys.exit("没找到任何串口。线插好了吗?")
    # ESP32-S3 原生 USB 是 VID 303A;板上若走 USB-UART 桥则是别的芯片。优先前者。
    esp = [p for p in ports if (p.vid == 0x303A) or ("USB" in (p.description or "").upper() and p.vid)]
    pick = esp or ports
    if len(pick) == 1:
        print(f"串口: {pick[0].device}  ({pick[0].description})")
        return pick[0].device
    print("找到多个串口,用 --port 指定一个:")
    for p in pick:
        print(f"  {p.device}  {p.description}")
    sys.exit(1)


def gen_nvs_url(url):
    """本地生成 24KB NVS 镜像,只写一个键:wifi/ota_url(ota.cc 就认它)。
    这是新用户接入的第一步 —— 出厂固件不动,只把「去哪拿配置」指向你自己的网关。
    ⚠️整个 NVS 分区会被覆盖,板子存的 WiFi 一并被清,烧完要重新配一次网。"""
    os.makedirs(CACHE, exist_ok=True)
    csv = os.path.join(CACHE, "nvs-url.csv")
    out = os.path.join(CACHE, "nvs-url.bin")
    with open(csv, "w", encoding="utf-8", newline="\n") as f:
        f.write("key,type,encoding,value\n")
        f.write("wifi,namespace,,\n")
        f.write(f"ota_url,data,string,{url}\n")
    # 生成工具是乐鑫官方的 nvs_partition_gen,pip 就有;入口名各版本不一,两种都试
    for cmd in ([sys.executable, "-m", "esp_idf_nvs_partition_gen", "generate"],
                ["nvs_partition_gen", "generate"]):
        try:
            r = subprocess.run(cmd + [csv, out, "0x6000"], capture_output=True, text=True, timeout=60)
            if r.returncode == 0 and os.path.exists(out) and os.path.getsize(out) == 0x6000:
                return out
        except FileNotFoundError:
            continue
    sys.exit(f"缺 NVS 生成工具:  {sys.executable} -m pip install esp-idf-nvs-partition-gen")


def esptool_cmd():
    """返回调用 esptool 的命令前缀。v4/v5 参数名不同,所以这里不传任何 flash 参数,
    让它默认 keep —— 直接沿用 bin 文件头里 IDF 已经写好的 dio/80m/16MB。"""
    try:
        r = subprocess.run([sys.executable, "-m", "esptool", "version"],
                           capture_output=True, text=True, timeout=30)
        if r.returncode == 0:
            print(f"esptool: {r.stdout.strip().splitlines()[-1] if r.stdout.strip() else '?'}")
            return [sys.executable, "-m", "esptool"]
    except Exception:
        pass
    sys.exit(f"没装 esptool:  {sys.executable} -m pip install esptool")


def main():
    ap = argparse.ArgumentParser()
    # 0815:不再硬编码 choices —— 服务端 gen-manifest.js 里加了新目标(app),这里忘了同步,
    # 用户跑 `flash.py app` 直接被 argparse 挡下"invalid choice"。目标清单以**服务端清单为准**,
    # 拉到之后再校验,以后加目标不用重下脚本。
    ap.add_argument("target", help="刷机目标;跑 `flash.py list` 看服务端当前提供哪些。"
                                   "`seturl` 是本地目标:把板子的配置地址指向你的网关(不走服务端清单)")
    ap.add_argument("--port")
    ap.add_argument("--baud", default="921600")
    ap.add_argument("--url", help="seturl 用:板子的 OTA 配置地址,默认 <BASE>/xiaozhi/ota/")
    ap.add_argument("--dry-run", action="store_true", help="只下载校验,不真刷")
    # 串口同一时间只能被一个程序占着,所以刷机和看日志天生冲突:
    # 要刷就得先关 relay,关了又抓不到刷完那次的**开机日志** —— 而开机那几十秒恰恰是最值钱的
    # (AFE 建在哪、内存剩多少、WS 连没连上,全在里头)。0815 就因为这个,好几次拿着上一版的旧日志
    # 分析当前版本,判断一错再错。
    # 所以刷完**默认自动接上 relay**,中间不用人去掐时间。
    ap.add_argument("--no-relay", action="store_true",
                    help="刷完不自动开串口日志(默认会开)")
    a = ap.parse_args()

    # ---- seturl:纯本地,不拉服务端清单 ----
    # 新用户第一步就是它,那会儿网关的固件目录八成还是空的,manifest 都没有 —— 所以必须不依赖清单。
    if a.target == "seturl":
        url = a.url or f"{BASE}/xiaozhi/ota/"
        print(f"\n把板子的配置地址指向: {url}")
        print("⚠️ 这一步会清掉板子里存的 WiFi,烧完要重新配一次网。\n")
        nvs = gen_nvs_url(url)
        cmd = esptool_cmd()
        port = a.port or find_port()
        args = cmd + ["--chip", "esp32s3", "--port", port, "--baud", a.baud,
                      "write_flash", "0x9000", nvs]
        print(f"\n开始烧录 → {port}\n")
        rc = subprocess.call(args)
        if rc != 0:
            print("\n烧录失败。板子没进下载模式的话:按住 BOOT 不放,点一下 RESET,松开 BOOT,再跑一次。")
            sys.exit(rc)
        print("\n烧好了。板子重启后进配网页面,连上 WiFi 它就会来你的网关拿配置(服务器地址、token 都在里面)。")
        if not a.no_relay:
            start_relay(port)
        return

    print("拉取清单…")
    r = requests.get(f"{BASE}/fw/file/manifest.json", headers={"X-Token": TOKEN}, timeout=30)
    r.raise_for_status()
    man = r.json()
    if a.target == "list" or a.target not in man["targets"]:
        if a.target != "list":
            print(f"\n没有目标「{a.target}」。服务端当前提供:\n")
        else:
            print()
        for k, v in man["targets"].items():
            print(f"  {k:<10} {v['label']}")
            print(f"  {'':<10} {v['note']}")
        sys.exit(0 if a.target == "list" else 2)
    t = man["targets"][a.target]

    print(f"\n目标: {t['label']}")
    print(f"      {t['note']}")
    print(f"      {len(t['parts'])} 段, 共 {human(t['totalBytes'])}\n")

    files = []
    for p in t["parts"]:
        files.append((p["addr"], fetch(p["file"], p["size"], p["sha256"])))

    if a.dry_run:
        print("\n--dry-run:文件都备齐了,没有真刷。")
        return

    cmd = esptool_cmd()
    port = a.port or find_port()
    args = cmd + ["--chip", "esp32s3", "--port", port, "--baud", a.baud, "write_flash"]
    for addr, path in files:
        args += [addr, path]

    print(f"\n开始烧录 → {port}")
    print("  " + " ".join(args[len(cmd):]) + "\n")
    rc = subprocess.call(args)
    if rc != 0:
        print("\n烧录失败。常见原因:")
        print("  · serial-relay.py 还开着占住串口 → 关掉那个窗口再来")
        print("  · 板子没进下载模式 → 按住 BOOT 键不放,点一下 RESET,松开 BOOT,再跑一次")
        print(f"  · 速率太高 → 加 --baud 460800")
        sys.exit(rc)

    print("\n烧好了。板子会自己重启。")
    if a.target == "face":
        print("她的 21 张表情 + 黑底已刷。字体和唤醒词模型没动。")
        print("不满意就:  python flash.py back   刷回官方 assets。")
    elif a.target == "dark":
        print("黑底白字已刷。表情图和字体都还是官方原版,只有背景/文字颜色变了。")
        print("不喜欢就:  python flash.py back   刷回官方 assets。")
    elif a.target == "rescue":
        print("分区表和两个数据分区都刷回出厂了,SPIFFS 能挂上,板子应该正常开机。")
        print("NVS 没碰 —— WiFi 和服务器地址都还在,开机直接连回来。")
    elif a.target == "back":
        print("官方 assets 已刷回:唤醒词恢复成「你好小智」,字号恢复 30px。")
        print("WiFi 和服务器地址都没动,开机直接连回来。")
    elif a.target == "wake":
        print("assets 分区已扩到 5MB,自定义唤醒词模型装进去了。")
        print("WiFi 和服务器地址都没动(NVS 没碰),开机应该直接连上来。")
        print("要是板子起不来或表现异常:  python flash.py stock   然后 otaurl 重来一遍。")
    elif a.target == "otaurl":
        print("服务器地址已经写进板子。WiFi 被清掉了,开机重新配一次网——")
        print("配完它就会连到我们的网关(不用管配网页面里有没有 OTA 那一栏,地址已经在 NVS 里了)。")
        print("想回官方云:  python flash.py stock   (整片刷会一并清掉这个地址)")
    elif a.target == "stock":
        print("现在是微雪出厂固件:Brookesia 启动器,进「设置」配 WiFi,「小智AI」是它自带的语音助手。")
        print("想刷回来:  python flash.py xixi")
    else:
        print("现在是语音终端。WiFi 需要重新配(NVS 被官方固件覆盖过)。")
        print("想再看官方的:  python flash.py stock")

    if not a.no_relay:
        start_relay(port)


def start_relay(port):
    """刷完直接接上串口日志。板子这会儿正在重启,开机日志就是这么抓到的。"""
    relay = os.path.join(os.path.dirname(os.path.abspath(__file__)), "serial-relay.py")
    if not os.path.exists(relay):
        print(f"\n(没找到 {relay},就不自动开日志了)")
        return
    print("\n" + "─" * 56)
    print("接上串口日志(Ctrl+C 停)。板子正在重启,开机日志马上就来。")
    print("─" * 56 + "\n")
    # 板子刚被 esptool 硬复位,USB CDC 要重新枚举,端口有一两秒不可用 —— 等一下再连,
    # 别刚烧完就去开、开不着就放弃。
    time.sleep(2)
    try:
        subprocess.call([sys.executable, relay, port])
    except KeyboardInterrupt:
        print("\n日志已停。")


if __name__ == "__main__":
    main()
