#!/bin/bash
# ota-switch.sh — OTA 刹车/油门。板子卡在升级页面时用它止损。
#   ./ota-switch.sh off        关掉 OTA(报 0.0.0=永不升级)。板子重启后直接进对话,不再尝试下载。
#   ./ota-switch.sh on 2.4.8   重新挂上某一版(固件从 config.json 的 firmwareDir 里找)
#   ./ota-switch.sh on 2.4.8 /路径/app.bin   直接指定固件文件
#   ./ota-switch.sh status     看当前挂的是哪版
set -e
CFG="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/config.json"
case "$1" in
  off)
    node -e '
      const fs=require("fs"),p=process.argv[1];
      const c=JSON.parse(fs.readFileSync(p,"utf8"));
      c.otaSaved = c.ota || c.otaSaved || null;   // 记住原来挂的版本,方便一键挂回
      delete c.ota;
      fs.writeFileSync(p,JSON.stringify(c,null,2));
      console.log("OTA 已关闭" + (c.otaSaved ? "(原挂 " + c.otaSaved.version + ",用 on 挂回)" : ""));
    ' "$CFG"
    systemctl restart xixi-terminal && echo "网关已重启,板子重启后不会再进升级页"
    ;;
  on)
    V="${2:-}"
    node -e '
      const fs=require("fs"),p=process.argv[1],v=process.argv[2];
      const c=JSON.parse(fs.readFileSync(p,"utf8"));
      const ver=v||(c.otaSaved&&c.otaSaved.version);
      if(!ver){console.error("要给版本号,例如 on 2.4.8");process.exit(1);}
      // 固件目录:config.json 的 firmwareDir,默认 board/firmware。文件名试几种常见写法,
      // 也可以直接 `on <版本> <文件路径>` 把路径给全。
      const path=require("path");
      const dir=c.firmwareDir||path.join(path.dirname(p),"board","firmware");
      const tail=ver.split(".").pop();
      const cands=process.argv[3]?[process.argv[3]]
        :[`${dir}/app-v${ver}.bin`,`${dir}/xixi-v${tail}-app.bin`,`${dir}/firmware-${ver}.bin`];
      const f=cands.find(x=>fs.existsSync(x));
      if(!f){console.error("找不到固件,试过:\n  "+cands.join("\n  "));process.exit(1);}
      c.ota={version:ver,file:f}; delete c.otaSaved;
      fs.writeFileSync(p,JSON.stringify(c,null,2));
      console.log("OTA 已挂上 "+ver+" → "+f);
    ' "$CFG" "$V" "${3:-}"
    systemctl restart xixi-terminal && echo "网关已重启"
    ;;
  status|*)
    node -e '
      const fs=require("fs");const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
      console.log(c.ota ? "当前挂着 "+c.ota.version+" → "+c.ota.file : "OTA 关闭中(板子不会升级)");
    ' "$CFG"
    ;;
esac
