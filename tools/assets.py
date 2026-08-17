# assets.py — 板子表情包(assets 分区)拆包/打包/烧录,零依赖(烧录才要 esptool)。
#
#   python assets.py unpack assets.bin my_faces/     拆开,21 张表情 PNG 一眼可见
#   python assets.py pack   my_faces/ my.bin         改完图重新打包(带分区大小校验)
#   python assets.py flash  my.bin                   烧进板子(assets 分区,不碰固件和 WiFi)
#
# 官方 assets 包自己从微雪 wiki 下载(ESP32-S3-Touch-AMOLED-2.16 页面),本仓库不内置;
# 找不到就直接从自己板子里读出来(USB 连着):
#   python -m esptool --chip esp32s3 read_flash 0x920000 0x300000 assets.bin
# 换表情 = unpack → 用自己的图同名替换(表情是 64×64 的 PNG,透明背景白色线条) → pack → flash。
# 加新表情要同时编辑目录里的 index.json(板子按它找表情名),只是换脸就不用动。
# 刷坏了最多没表情,不影响开机;把官方原包 flash 回去就恢复。
#
# 包格式(与 xiaozhi-esp32 的 build_default_assets.py / 乐鑫 esp_mmap_assets 一致,MIT/Apache-2.0):
#   header  = 文件数(4LE) + checksum(4LE) + 数据长(4LE)
#   数据    = 索引表 + 文件体们;索引表每条 = 名字(32 字节 \0 填充) + size(4LE) + offset(4LE) + 宽高(各2LE,恒0)
#   文件体  = 0x5A5A 两字节前缀 + 原文件;offset 指向前缀,真实数据在 offset+2(拆包最容易栽的坑)
#   checksum = 数据区逐字节累加 & 0xFFFF
# 出厂老版工具打的包这两个字段语义不同(数据长=整文件长),拆包时兼容、只提示不报错;
# 重新打包后按新语义写,现行固件(含本仓库 Releases 的 fw-v2.5.0)认的就是新语义。
import argparse
import os
import struct
import subprocess
import sys

NAME_LEN = 32
ENTRY = NAME_LEN + 12
PARTITION = 0x300000      # assets 分区 3MB(微雪 2.16 出厂分区表)
FLASH_ADDR = "0x920000"   # assets 分区起点


def die(msg):
    sys.exit("错误: " + msg)


def unpack(bin_path, out_dir):
    d = open(bin_path, "rb").read()
    if len(d) < 12:
        die("文件太小,不像 assets 包")
    n, ck, ln = struct.unpack("<III", d[:12])
    if not (0 < n < 1000):
        die(f"文件数 {n} 不合理,这不是 assets 包(或者切了头)")
    body = d[12:]
    real_ck = sum(body) & 0xFFFF
    if ck != real_ck:
        # 出厂老版工具的包会走到这:字段语义不同,不影响按索引表拆
        print(f"提示: 头部 checksum 0x{ck:04X} 与实算 0x{real_ck:04X} 不一致(老版打包工具的包会这样),继续拆")
    table_end = n * ENTRY
    if body[table_end:table_end + 2] != b"\x5A\x5A":
        die("索引表之后不是 0x5A5A 前缀,格式对不上")
    os.makedirs(out_dir, exist_ok=True)
    data = body[table_end:]
    for i in range(n):
        e = body[i * ENTRY:(i + 1) * ENTRY]
        name = e[:NAME_LEN].rstrip(b"\0").decode("utf-8")
        size, off = struct.unpack("<II", e[NAME_LEN:NAME_LEN + 8])
        if data[off:off + 2] != b"\x5A\x5A":
            die(f"{name} 的数据前缀不对(offset={off})")
        blob = data[off + 2:off + 2 + size]   # size 不含 2 字节前缀,真实数据在 off+2
        if len(blob) != size:
            # 按老语义截断保存过的包会缺尾巴几个字节,只影响最后一个文件——跳过它,别整包拆不了
            print(f"  {name:34s} 警告: 数据不完整({len(blob)}/{size}),跳过。"
                  "从板子重新 read_flash 一份就是完整的")
            continue
        with open(os.path.join(out_dir, name), "wb") as f:
            f.write(blob)
        print(f"  {name:34s} {size:>9,} 字节")
    print(f"\n拆出 {n} 个文件 → {out_dir}")
    print("表情就是那些 PNG;改完用 pack 重新打包。")


def sort_key(filename):
    base, ext = os.path.splitext(filename)
    return ext, base


def png_size(blob):
    # PNG 的宽高在 IHDR 里(大端)。索引表要带上它——板端渲染用,填 0 的包不保真
    if blob[:8] == b"\x89PNG\r\n\x1a\n" and len(blob) >= 24:
        w = int.from_bytes(blob[16:20], "big")
        h = int.from_bytes(blob[20:24], "big")
        return w, h
    return 0, 0


def pack(src_dir, out_path):
    if not os.path.isdir(src_dir):
        die(f"目录不存在: {src_dir}")
    files = sorted(
        (f for f in os.listdir(src_dir)
         if os.path.isfile(os.path.join(src_dir, f)) and f != "config.json"),
        key=sort_key)
    if "index.json" not in files:
        die("目录里没有 index.json —— 板子靠它找表情,应从 unpack 的产物改起")
    merged = bytearray()
    info = []
    for name in files:
        if len(name.encode("utf-8")) > NAME_LEN:
            die(f"文件名超 {NAME_LEN} 字节: {name}")
        blob = open(os.path.join(src_dir, name), "rb").read()
        w, h = png_size(blob) if name.lower().endswith(".png") else (0, 0)
        info.append((name, len(merged), len(blob), w, h))
        merged.extend(b"\x5A\x5A")
        merged.extend(blob)
    table = bytearray()
    for name, off, size, w, h in info:
        table.extend(name.encode("utf-8").ljust(NAME_LEN, b"\0"))
        table.extend(size.to_bytes(4, "little"))
        table.extend(off.to_bytes(4, "little"))
        table.extend(w.to_bytes(2, "little"))
        table.extend(h.to_bytes(2, "little"))
    combined = bytes(table) + bytes(merged)
    ck = sum(combined) & 0xFFFF
    out = (len(info).to_bytes(4, "little") + ck.to_bytes(4, "little")
           + len(combined).to_bytes(4, "little") + combined)
    if len(out) > PARTITION:
        die(f"打出来 {len(out):,} 字节,超过分区 {PARTITION:,} —— 图太大了。"
            "表情 PNG 每张两三 KB 就够,检查是不是塞了大图进去")
    with open(out_path, "wb") as f:
        f.write(out)
    free = PARTITION - len(out)
    print(f"打包 {len(info)} 个文件 → {out_path}")
    print(f"  {len(out):,} 字节,分区余量 {free:,}(checksum 0x{ck:04X})")


def find_port():
    try:
        from serial.tools import list_ports
    except ImportError:
        die("缺 pyserial:  pip install pyserial")
    ports = list(list_ports.comports())
    if not ports:
        die("没找到串口。线插好了吗?")
    esp = [p for p in ports if (p.vid == 0x303A) or ("USB" in (p.description or "").upper() and p.vid)]
    pick = esp or ports
    if len(pick) == 1:
        print(f"串口: {pick[0].device}  ({pick[0].description})")
        return pick[0].device
    print("找到多个串口,用 --port 指定一个:")
    for p in pick:
        print(f"  {p.device}  {p.description}")
    sys.exit(1)


def flash(bin_path, port, baud):
    if not os.path.exists(bin_path):
        die(f"文件不存在: {bin_path}")
    sz = os.path.getsize(bin_path)
    if sz > PARTITION:
        die(f"{sz:,} 字节超过 assets 分区 {PARTITION:,},不能烧")
    cmd = [sys.executable, "-m", "esptool", "--chip", "esp32s3",
           "--port", port or find_port(), "--baud", baud,
           "write_flash", FLASH_ADDR, bin_path]
    print("烧录(只写 assets 分区,固件/WiFi/服务器地址都不动):")
    print("  " + " ".join(cmd[2:]))
    rc = subprocess.call(cmd)
    if rc != 0:
        print("烧录失败。板子没进下载模式的话:按住 BOOT 不放,点一下 RESET,松开 BOOT,再来一次。")
        sys.exit(rc)
    print("烧好了,板子重启后就是新表情。不满意就把官方原包 flash 回去。")


def main():
    ap = argparse.ArgumentParser(description="板子表情包拆包/打包/烧录")
    sub = ap.add_subparsers(dest="cmd", required=True)
    u = sub.add_parser("unpack"); u.add_argument("bin"); u.add_argument("dir")
    p = sub.add_parser("pack"); p.add_argument("dir"); p.add_argument("out")
    f = sub.add_parser("flash"); f.add_argument("bin")
    f.add_argument("--port"); f.add_argument("--baud", default="921600")
    a = ap.parse_args()
    if a.cmd == "unpack":
        unpack(a.bin, a.dir)
    elif a.cmd == "pack":
        pack(a.dir, a.out)
    else:
        flash(a.bin, a.port, a.baud)


if __name__ == "__main__":
    main()
