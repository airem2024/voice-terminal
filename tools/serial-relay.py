# serial-relay.py — 把板子的串口日志实时转给 VPS,让维护者能自己看板子在干什么。
# 用法(Windows PowerShell / CMD):  python serial-relay.py COM3
# 需要 pyserial(刷过 esptool 就已经有了)和 requests;缺 requests 就: pip install requests
#
# 通常不用单独跑它 —— `python flash.py <目标>` 刷完会自动接上来。
import os, sys, time
import serial, requests

PORT = sys.argv[1] if len(sys.argv) > 1 else "COM3"
BAUD = 115200

# 网关地址和 token 不写在代码里(这脚本跑在你自己电脑上,token 能刷固件)。
# 找法:环境变量 GW_BASE/GW_TOKEN → 本目录的 gateway.env(两行 BASE=… / TOKEN=…,不进仓库)。
_HERE = os.path.dirname(os.path.abspath(__file__))
_CONF = {}
_P = os.path.join(_HERE, "gateway.env")
if os.path.exists(_P):
    with open(_P, encoding="utf-8") as f:
        for _l in f:
            _l = _l.strip()
            if _l and not _l.startswith("#") and "=" in _l:
                _k, _v = _l.split("=", 1)
                _CONF[_k.strip()] = _v.strip()
BASE = (os.environ.get("GW_BASE") or _CONF.get("BASE") or "").rstrip("/")
TOKEN = os.environ.get("GW_TOKEN") or _CONF.get("TOKEN") or ""
if not BASE or not TOKEN:
    sys.exit("还没配网关地址。在 %s 里写 BASE= 和 TOKEN= 两行,或设环境变量 GW_BASE / GW_TOKEN。" % _P)
URL = BASE + "/devlog"


def open_port(first):
    """板子一重启,USB CDC 就会重新枚举,端口有几秒钟压根不存在。
    以前这里是直上 serial.Serial(),开不着就整个脚本崩掉 —— 于是每次板子重启(刷完机、
    或者它自己崩了重启)日志就断在那儿,而**重启后那几十秒的开机日志恰恰是最值钱的**。
    改成一直等,等到端口回来为止。"""
    said = False
    while True:
        try:
            s = serial.Serial(PORT, BAUD, timeout=1)
            print(f"{'已连上' if first else '串口回来了 →'} {PORT}"
                  + ("  日志同时显示在这里并转给服务器。Ctrl+C 停止。" if first else ""))
            return s
        except KeyboardInterrupt:
            raise
        except Exception as e:
            if not said:
                print(f"[等 {PORT} …  {e}]")
                said = True
            time.sleep(1)


def main():
    ser = open_port(True)
    buf, last = [], time.time()
    while True:
        try:
            line = ser.readline()
            if line:
                text = line.decode("utf-8", "replace")
                sys.stdout.write(text)
                sys.stdout.flush()
                buf.append(text)
            # 每 1 秒或攒够 50 行发一批,别一行一个请求
            if buf and (time.time() - last > 1 or len(buf) >= 50):
                try:
                    requests.post(URL, data="".join(buf).encode("utf-8"),
                                  headers={"X-Token": TOKEN}, timeout=10)
                except Exception as e:
                    print(f"[转发失败 {e}]")
                buf, last = [], time.time()
        except KeyboardInterrupt:
            break
        except Exception as e:
            # 板子重启把串口带走了。把攒着的先发出去,再等它回来 —— 别把这几行丢了。
            print(f"[串口断了 {e}]")
            if buf:
                try:
                    requests.post(URL, data="".join(buf).encode("utf-8"),
                                  headers={"X-Token": TOKEN}, timeout=10)
                except Exception:
                    pass
                buf, last = [], time.time()
            try:
                ser.close()
            except Exception:
                pass
            ser = open_port(False)
    try:
        ser.close()
    except Exception:
        pass


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
