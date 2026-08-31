#!/usr/bin/env bash
# systemdashboard metrics collector
# Runs inside the `agent` container. Reads host metrics via a read-only
# bind mount of / at $HOST_ROOT (rslave propagation) plus the docker socket,
# and writes a single JSON snapshot to $OUT_FILE on every tick.
set -uo pipefail

HOST="${HOST_ROOT:-/host}"
OUT="${OUT_FILE:-/www/data.json}"
OUTDIR="$(dirname "$OUT")"
INTERVAL="${INTERVAL:-300}"   # slow heartbeat; the UI triggers fresh samples on demand
IFACE_ENV="${NET_IFACE:-}"
DISKS="${DISKS:-/}"
VNSTAT_DB="$HOST/var/lib/vnstat"
STATE="/tmp/state"
mkdir -p "$STATE"
# sparkline history + refresh trigger live next to data.json (the .trend history
# survives container rebuilds; the web server refuses dotfiles)
TREND_FILE="$OUTDIR/.trend"
TRIGGER="$OUTDIR/.refresh"
touch "$TREND_FILE" 2>/dev/null || true   # so collect()'s --rawfile read never misses it

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

pick_iface() {
  if [ -n "$IFACE_ENV" ]; then echo "$IFACE_ENV"; return; fi
  vnstat --json --dbdir "$VNSTAT_DB" 2>/dev/null \
    | jq -r '.interfaces[].name' 2>/dev/null \
    | grep -Ev '^(lo|docker|veth|br-|virbr|tap|tun)' | head -n1
}

mount_source() {  # $1 = host mountpoint -> device / remote
  awk -v m="$1" '{
    if ($5 == m) { for (i = 6; i <= NF; i++) if ($i == "-") { print $(i+2); exit } }
  }' "$HOST/proc/1/mountinfo"
}

host_json() {
  local hn distro kernel up
  # /proc/sys/kernel/hostname is UTS-namespaced (would show the container id),
  # so read the host's hostname file instead.
  hn=$(cat "$HOST/etc/hostname" 2>/dev/null | xargs)
  [ -n "$hn" ] || hn=$(cat "$HOST/proc/sys/kernel/hostname" 2>/dev/null || echo unknown)
  distro=$( (. "$HOST/etc/os-release" 2>/dev/null; echo "${PRETTY_NAME:-Linux}") )
  kernel=$(cat "$HOST/proc/sys/kernel/osrelease" 2>/dev/null || echo "?")
  up=$(awk '{printf "%d", $1}' "$HOST/proc/uptime" 2>/dev/null || echo 0)
  jq -cn --arg hn "$hn" --arg d "$distro" --arg k "$kernel" --argjson up "${up:-0}" \
    '{name:$hn, distro:$d, kernel:$k, uptime:$up}'
}

mem_json() {
  # kB values * 1024 overflow busybox awk's 32-bit int printf("%d"); use %.0f
  # (awk math is double precision, exact well past terabytes).
  awk '
    /^MemTotal:/     {t=$2*1024.0}
    /^MemAvailable:/ {a=$2*1024.0}
    /^MemFree:/      {f=$2*1024.0}
    /^Buffers:/      {b=$2*1024.0}
    /^Cached:/       {c=$2*1024.0}
    /^SReclaimable:/ {sr=$2*1024.0}
    /^SwapTotal:/    {st=$2*1024.0}
    /^SwapFree:/     {sf=$2*1024.0}
    END {
      cache=c+b+sr; used=t-a; if (used<0) used=0
      printf "{\"total\":%.0f,\"used\":%.0f,\"available\":%.0f,\"free\":%.0f,\"cache\":%.0f,\"swapTotal\":%.0f,\"swapUsed\":%.0f}",
             t, used, a, f, cache, st, st-sf
    }' "$HOST/proc/meminfo"
}

cpu_json() {
  local line idle total v pct=0 dt di
  line=$(grep '^cpu ' "$HOST/proc/stat")
  # cpu user nice system idle iowait irq softirq steal guest guest_nice
  set -- $line
  idle=$(( $5 + $6 ))
  total=0; shift
  for v in "$@"; do total=$((total + v)); done
  if [ -f "$STATE/cpu" ]; then
    read -r pt pi < "$STATE/cpu"
    dt=$((total - pt)); di=$((idle - pi))
    [ "$dt" -gt 0 ] && pct=$(( (100 * (dt - di)) / dt ))
  fi
  echo "$total $idle" > "$STATE/cpu"
  [ "$pct" -lt 0 ] && pct=0
  [ "$pct" -gt 100 ] && pct=100

  # per-core usage from cpuN lines, delta vs previous tick
  local cn rest ct ci ppt ppi cp
  local per_vals=()
  while read -r cn rest; do
    case "$cn" in cpu[0-9]*) ;; *) continue ;; esac
    set -- $rest
    ci=$(( $4 + $5 )); ct=0
    for v in "$@"; do ct=$((ct + v)); done
    cp=0
    if [ -f "$STATE/$cn" ]; then
      read -r ppt ppi < "$STATE/$cn"
      local cdt=$((ct - ppt)) cdi=$((ci - ppi))
      [ "$cdt" -gt 0 ] && cp=$(( (100 * (cdt - cdi)) / cdt ))
    fi
    echo "$ct $ci" > "$STATE/$cn"
    [ "$cp" -lt 0 ] && cp=0; [ "$cp" -gt 100 ] && cp=100
    per_vals+=("$cp")
  done < "$HOST/proc/stat"
  local per="[$(IFS=,; echo "${per_vals[*]-}")]"   # integers -> JSON array, no jq per core

  local ncpu load
  ncpu=$(grep -c '^processor' "$HOST/proc/cpuinfo" 2>/dev/null || echo 1)
  load=$(cut -d' ' -f1-3 "$HOST/proc/loadavg" 2>/dev/null || echo "0 0 0")
  set -- $load
  jq -cn --argjson pct "$pct" --argjson n "${ncpu:-1}" --argjson per "$per" \
     --argjson l1 "${1:-0}" --argjson l5 "${2:-0}" --argjson l15 "${3:-0}" \
     '{usage:$pct, cores:$n, per:$per, load:[$l1,$l5,$l15]}'
}

temp_json() {
  # collect "label<TAB>value" lines, then one jq pass (labels never contain tabs)
  local lines="" hw nm f base lbl val z
  for hw in "$HOST"/sys/class/hwmon/hwmon*; do
    [ -r "$hw/name" ] || continue
    nm=$(cat "$hw/name" 2>/dev/null)
    case "$nm" in
      coretemp|k10temp|zenpower|cpu_thermal|*thermal*|nct*|it87*) ;;
      *) continue ;;
    esac
    for f in "$hw"/temp*_input; do
      [ -r "$f" ] || continue
      base=${f%_input}
      lbl=$(cat "${base}_label" 2>/dev/null || echo "$nm")
      val=$(awk '{printf "%.0f", $1/1000}' "$f" 2>/dev/null)
      [ -n "$val" ] && lines+="$lbl"$'\t'"$val"$'\n'
    done
  done
  if [ -z "$lines" ]; then
    for z in "$HOST"/sys/class/thermal/thermal_zone*; do
      [ -r "$z/temp" ] || continue
      lbl=$(cat "$z/type" 2>/dev/null || echo zone)
      val=$(awk '{printf "%.0f", $1/1000}' "$z/temp" 2>/dev/null)
      [ -n "$val" ] && lines+="$lbl"$'\t'"$val"$'\n'
    done
  fi
  printf '%s' "$lines" | jq -R -s '
    [ splits("\n") | select(length > 0) | split("\t") | { label: .[0], value: (.[1] | tonumber) } ] as $s |
    {
      sensors: $s,
      package: ( ($s | map(select(.label | test("package|pkg|composite|tctl|tdie"; "i"))) | .[0].value)
                 // ($s | map(.value) | max) ),
      max: ( $s | map(.value) | max // null )
    }'
}

disks_json() {
  local out="[]" m p src base parent model rota
  local bs blocks bfree bavail size used avail pct
  IFS=',' read -ra MS <<< "$DISKS"
  for m in "${MS[@]}"; do
    m=$(echo "$m" | xargs)
    [ -n "$m" ] || continue
    if [ "$m" = "/" ]; then p="$HOST"; else p="$HOST$m"; fi
    [ -d "$p" ] || continue

    # statvfs via busybox stat -f: %S block size, %b total, %f free, %a avail
    read -r bs blocks bfree bavail < <(stat -f -c '%S %b %f %a' "$p" 2>/dev/null || echo "0 0 0 0")
    [ "${blocks:-0}" -gt 0 ] || continue
    size=$(( bs * blocks ))
    avail=$(( bs * bavail ))
    used=$(( bs * (blocks - bfree) ))
    if [ $(( used + avail )) -gt 0 ]; then
      pct=$(( 100 * used / (used + avail) ))
    else
      pct=0
    fi

    src=$(mount_source "$m"); [ -n "$src" ] || src="?"
    model=""; rota=""
    if [ "${src#/dev/}" != "$src" ]; then
      base=${src#/dev/}
      if [ -e "$HOST/sys/class/block/$base/partition" ]; then
        parent=$(basename "$(readlink -f "$HOST/sys/class/block/$base/.." 2>/dev/null)")
      else
        parent=$base
      fi
      model=$(cat "$HOST/sys/class/block/$parent/device/model" 2>/dev/null | xargs || true)
      rota=$(cat "$HOST/sys/class/block/$parent/queue/rotational" 2>/dev/null || echo "")
    fi
    local fstype
    fstype=$(awk -v mp="$m" '{ if ($5==mp) { for(i=6;i<=NF;i++) if($i=="-"){print $(i+1); exit} } }' "$HOST/proc/1/mountinfo")

    out=$(echo "$out" | jq -c \
      --arg mount "$m" --arg src "$src" --arg model "$model" --arg fs "${fstype:-}" \
      --argjson size "$size" --argjson used "$used" --argjson avail "$avail" --argjson pct "$pct" \
      --arg rota "$rota" \
      '. + [{mount:$mount, source:$src, model:$model, fstype:$fs,
             rotational:($rota=="1"), size:$size, used:$used, avail:$avail, pct:$pct}]')
  done
  echo "$out"
}

net_json() {
  local iface="$1"
  [ -n "$iface" ] || { echo 'null'; return; }

  # live throughput: bytes/sec, from rx/tx byte counters between ticks
  local rx tx now prev_rx prev_tx prev_t rx_Bps=0 tx_Bps=0
  rx=$(cat "$HOST/sys/class/net/$iface/statistics/rx_bytes" 2>/dev/null || echo 0)
  tx=$(cat "$HOST/sys/class/net/$iface/statistics/tx_bytes" 2>/dev/null || echo 0)
  now=$(date +%s.%N)
  if [ -f "$STATE/net" ]; then
    read -r prev_rx prev_tx prev_t < "$STATE/net"
    local dt
    dt=$(awk -v a="$now" -v b="$prev_t" 'BEGIN{printf "%.3f", a-b}')
    if awk -v d="$dt" 'BEGIN{exit !(d>0.1)}'; then
      rx_Bps=$(awk -v c="$rx" -v p="$prev_rx" -v d="$dt" 'BEGIN{v=(c-p)/d; printf "%.0f", (v<0?0:v)}')
      tx_Bps=$(awk -v c="$tx" -v p="$prev_tx" -v d="$dt" 'BEGIN{v=(c-p)/d; printf "%.0f", (v<0?0:v)}')
    fi
  fi
  echo "$rx $tx $now" > "$STATE/net"

  local ep
  ep=$(date +%s)

  # vnStat reads its DB in the reading process's timezone, so the agent's TZ
  # (from .env) MUST match the host's system timezone — then vnStat's own
  # day/month buckets roll over at the right local midnight and its `timestamp`
  # fields are correct epochs. (If .env TZ and the host differ, today/month
  # boundaries will be off by the offset between them.)
  vnstat --json --dbdir "$VNSTAT_DB" -i "$iface" 2>/dev/null | jq -c \
    --argjson rxBps "${rx_Bps:-0}" --argjson txBps "${tx_Bps:-0}" --arg iface "$iface" \
    --argjson now "$ep" '
    .interfaces[0] as $if | ($if.traffic) as $t |
    ( $if.created.timestamp // 0 ) as $created |

    # average rate = bytes / seconds the bucket actually spans, from its own
    # start (or the vnstat tracking start, whichever is later) to now.
    def summary(bucket):
      ( bucket | last // {rx:0, tx:0, timestamp:$now} ) as $b |
      ( [ $now - ([ ($b.timestamp // 0), $created ] | max), 1 ] | max ) as $secs |
      { rx: $b.rx, tx: $b.tx, avgRx: ($b.rx / $secs), avgTx: ($b.tx / $secs) };

    # recent buckets as chart bars, labelled in local time
    def bars(bucket; n; short; long):
      ( bucket // [] | .[-n:] | map({
          label: ( .timestamp | strflocaltime(short) ),
          title: ( .timestamp | strflocaltime(long) ),
          rx, tx }) );

    {
      iface:  $iface,
      rateRx: $rxBps,
      rateTx: $txBps,
      today:  summary($t.day),
      month:  summary($t.month),
      total:  ( $t.total // {rx:0, tx:0} ),
      days:   bars($t.day;  30; "%m-%d";    "%Y-%m-%d"),
      hours:  bars($t.hour; 24; "%H:00";    "%m-%d %H:00")
    }' || echo 'null'
}

docker_json() {
  local ps stats anon
  ps=$(docker ps -a --no-trunc --format '{{json .}}' 2>/dev/null | jq -s '
    [ .[] | {
        name:   .Names,
        id:     ( .ID // .Id // "" ),
        state:  .State,
        status: .Status,
        health: ( .Status | capture("\\((?<h>healthy|unhealthy|health: starting|starting)\\)").h // null )
      } ]' 2>/dev/null)
  [ -n "$ps" ] || ps='[]'

  # per-container cpu (one sample; ~1-2s, fine at this interval). MemUsage from
  # docker stats includes active page cache (cgroup v2) so we don't use it for
  # memory — see `anon` below.
  stats=$(docker stats --no-stream --format '{{json .}}' 2>/dev/null | jq -s '
    [ .[] | { name: .Name, cpu: ( .CPUPerc | rtrimstr("%") | tonumber? // 0 ) } ]' 2>/dev/null)
  [ -n "$stats" ] || stats='[]'

  # real memory = anonymous pages from each container's cgroup memory.stat
  # (excludes reclaimable page cache). Container id/name come from $ps, not a
  # second `docker ps`; each memory.stat is read with the shell, not awk.
  anon=$(printf '%s' "$ps" | jq -r '.[] | "\(.id)\t\(.name)"' | while IFS=$'\t' read -r cid cname; do
    [ -n "$cid" ] || continue
    for p in "$HOST/sys/fs/cgroup/system.slice/docker-$cid.scope/memory.stat" \
             "$HOST/sys/fs/cgroup/docker/$cid/memory.stat" \
             "$HOST/sys/fs/cgroup/memory/docker/$cid/memory.stat"; do
      [ -f "$p" ] || continue
      while read -r k v _; do
        case "$k" in anon|total_rss) printf '%s\t%s\n' "$cname" "$v" ;; esac
      done < "$p"
      break
    done
  done | jq -R -s 'split("\n") | map(select(length>0) | split("\t") | {(.[0]): (.[1]|tonumber)}) | add // {}')
  [ -n "$anon" ] || anon='{}'

  jq -cn --argjson ps "$ps" --argjson stats "$stats" --argjson anon "$anon" '
    ( $stats | map({ (.name): . }) | add // {} ) as $s |
    $ps
    | map( .cpu = ( $s[.name].cpu // null ) | .mem = ( $anon[.name] // null ) )
    | sort_by( (if .state == "running" then 0 else 1 end), -( .mem // -1 ) )
  ' 2>/dev/null || echo "${ps:-[]}"
}

# ---------------------------------------------------------------------------
# main tick
# ---------------------------------------------------------------------------

# append one {cpu%,mem%,temp} sample to the rolling history (last 60), for the
# UI sparklines. collect() reads the file back inline via --rawfile.
trend_row() {
  jq -cn --argjson c "$1" --argjson m "$2" --argjson t "$3" '{
    cpu:  ($c.usage // 0),
    mem:  (if ($m.total // 0) > 0 then ($m.used * 100 / $m.total) else 0 end),
    temp: ($t.package // null)
  }' 2>/dev/null >> "$TREND_FILE" || return
  tail -n 60 "$TREND_FILE" > "$TREND_FILE.t" 2>/dev/null && mv "$TREND_FILE.t" "$TREND_FILE"
}

collect() {
  local host mem cpu temp disks net docker
  [ -n "$IFACE" ] || IFACE=$(pick_iface)   # resolve once; retry only if still unknown
  host=$(host_json)
  mem=$(mem_json)
  cpu=$(cpu_json)
  temp=$(temp_json)
  disks=$(disks_json)
  net=$(net_json "$IFACE")
  docker=$(docker_json)
  trend_row "$cpu" "$mem" "$temp"

  jq -cn \
    --argjson host "$host" --argjson mem "$mem" --argjson cpu "$cpu" \
    --argjson temp "$temp" --argjson disks "$disks" --argjson net "${net:-null}" \
    --argjson docker "$docker" --rawfile trend "$TREND_FILE" \
    --argjson interval "${INTERVAL:-300}" \
    '{ts:(now|floor), interval:$interval, host:$host, mem:$mem, cpu:$cpu, temp:$temp,
      disks:$disks, net:$net, docker:$docker,
      trend: ($trend / "\n" | map(select(length > 0) | fromjson?))}' \
    > "$OUT.tmp" 2>/dev/null && mv "$OUT.tmp" "$OUT"
}

echo "systemdashboard agent: HOST=$HOST OUT=$OUT INTERVAL=${INTERVAL}s DISKS=$DISKS"
IFACE=$(pick_iface)
while true; do
  collect || echo "tick failed: $(date -Is)"
  # sleep INTERVAL, but wake early if something touches the trigger file
  i=0
  while [ "$i" -lt "$INTERVAL" ]; do
    if [ -e "$TRIGGER" ]; then rm -f "$TRIGGER"; break; fi
    sleep 1
    i=$((i + 1))
  done
done
