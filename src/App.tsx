import React, { useState, useCallback, useRef } from "react";
import { parseGptImage, GptParseResult, GptHeader, GptPartitionEntry } from "./utils/gptParser";

// ─── helpers ────────────────────────────────────────────────────────────────

function lbaToOffset(lba: bigint, sectorSize: number): string {
  const bytes = lba * BigInt(sectorSize);
  return `0x${bytes.toString(16).toUpperCase()}`;
}

function formatLba(lba: bigint): string {
  return lba.toString();
}

const OS_COLORS: Record<string, string> = {
  Qualcomm: "bg-blue-900 text-blue-200 border-blue-700",
  EFI: "bg-purple-900 text-purple-200 border-purple-700",
  Linux: "bg-green-900 text-green-200 border-green-700",
  Windows: "bg-sky-900 text-sky-200 border-sky-700",
  Generic: "bg-gray-700 text-gray-200 border-gray-600",
  Unknown: "bg-zinc-700 text-zinc-300 border-zinc-600",
  MBR: "bg-orange-900 text-orange-200 border-orange-700",
};

function OsBadge({ os }: { os: string }) {
  const cls = OS_COLORS[os] ?? OS_COLORS.Unknown;
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-bold border ${cls}`}>
      {os}
    </span>
  );
}

// ─── Header Card ─────────────────────────────────────────────────────────────

function HeaderCard({ header, title, sectorSize }: { header: GptHeader; title: string; sectorSize: number }) {
  return (
    <div className="rounded-xl border border-gray-700 bg-gray-800/60 p-4">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-xs font-bold uppercase tracking-widest text-gray-400">{title}</span>
        {header.crcValid ? (
          <span className="text-xs px-2 py-0.5 rounded-full bg-green-900/60 text-green-300 border border-green-700">✓ CRC32 正确</span>
        ) : (
          <span className="text-xs px-2 py-0.5 rounded-full bg-red-900/60 text-red-300 border border-red-700">✗ CRC32 错误</span>
        )}
        <span className="ml-auto text-xs text-gray-500 font-mono">@ 0x{header.offset.toString(16).toUpperCase()}</span>
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
        <Row label="签名 (Magic)" value={header.signature} mono />
        <Row label="版本" value={header.revision} mono />
        <Row label="头部大小" value={`${header.headerSize} 字节`} />
        <Row label="头部 CRC32" value={`0x${header.headerCrc32.toString(16).toUpperCase().padStart(8, "0")}`} mono />
        <Row label="当前 LBA" value={`${formatLba(header.currentLba)}  (${lbaToOffset(header.currentLba, sectorSize)})`} mono />
        <Row label="备份 LBA" value={`${formatLba(header.backupLba)}  (${lbaToOffset(header.backupLba, sectorSize)})`} mono />
        <Row label="首个可用 LBA" value={`${formatLba(header.firstUsableLba)}  (${lbaToOffset(header.firstUsableLba, sectorSize)})`} mono />
        <Row label="最后可用 LBA" value={`${formatLba(header.lastUsableLba)}  (${lbaToOffset(header.lastUsableLba, sectorSize)})`} mono />
        <Row label="磁盘 GUID" value={header.diskGuid} mono colSpan />
        <Row label="分区表起始 LBA" value={`${formatLba(header.partitionEntryLba)}  (${lbaToOffset(header.partitionEntryLba, sectorSize)})`} mono />
        <Row label="分区条目数" value={`${header.numPartitionEntries}`} />
        <Row label="分区条目大小" value={`${header.partitionEntrySize} 字节`} />
        <Row label="分区表 CRC32" value={`0x${header.partitionArrayCrc32.toString(16).toUpperCase().padStart(8, "0")}`} mono />
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
  colSpan,
}: {
  label: string;
  value: string;
  mono?: boolean;
  colSpan?: boolean;
}) {
  return (
    <>
      <div className={`text-gray-400 text-xs flex items-center${colSpan ? " col-span-2 mt-1" : ""}`}>{label}</div>
      <div
        className={`${mono ? "font-mono text-xs" : "text-xs"} text-gray-100 break-all${colSpan ? " col-span-2 mb-1" : ""}`}
      >
        {value}
      </div>
    </>
  );
}

// ─── Partition Table ──────────────────────────────────────────────────────────

const COLS = [
  { key: "index", label: "#", w: "w-8" },
  { key: "name", label: "名称", w: "w-32" },
  { key: "typeName", label: "类型", w: "w-40" },
  { key: "typeOs", label: "平台", w: "w-24" },
  { key: "startLba", label: "起始 LBA", w: "w-28" },
  { key: "endLba", label: "结束 LBA", w: "w-28" },
  { key: "sizeSectors", label: "扇区数", w: "w-24" },
  { key: "sizeHuman", label: "大小", w: "w-24" },
  { key: "attributes", label: "属性", w: "w-32" },
  { key: "typeGuid", label: "类型 GUID", w: "w-80" },
  { key: "uniqueGuid", label: "唯一 GUID", w: "w-80" },
];

function PartitionTable({
  partitions,
  sectorSize,
}: {
  partitions: GptPartitionEntry[];
  sectorSize: number;
}) {
  const [sortKey, setSortKey] = useState<string>("startLba");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [filter, setFilter] = useState("");
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);

  const handleSort = (key: string) => {
    if (sortKey === key) setSortDir(d => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  };

  const filtered = partitions.filter(p => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return (
      p.name.toLowerCase().includes(q) ||
      p.typeGuid.toLowerCase().includes(q) ||
      p.uniqueGuid.toLowerCase().includes(q) ||
      p.typeName.toLowerCase().includes(q) ||
      p.typeOs.toLowerCase().includes(q)
    );
  });

  const sorted = [...filtered].sort((a, b) => {
    let va: string | number | bigint;
    let vb: string | number | bigint;
    switch (sortKey) {
      case "startLba": va = a.startLba; vb = b.startLba; break;
      case "endLba": va = a.endLba; vb = b.endLba; break;
      case "sizeSectors": va = a.sizeSectors; vb = b.sizeSectors; break;
      case "sizeHuman": va = a.sizeBytes; vb = b.sizeBytes; break;
      case "index": va = a.index; vb = b.index; break;
      default:
        va = String((a as unknown as Record<string, unknown>)[sortKey] ?? "");
        vb = String((b as unknown as Record<string, unknown>)[sortKey] ?? "");
    }
    if (va < vb) return sortDir === "asc" ? -1 : 1;
    if (va > vb) return sortDir === "asc" ? 1 : -1;
    return 0;
  });

  const selectedPart = selectedIdx !== null ? partitions.find(p => p.index === selectedIdx) ?? null : null;

  return (
    <div>
      {/* filter bar */}
      <div className="mb-3 flex items-center gap-3">
        <input
          type="text"
          placeholder="搜索分区名、GUID、类型..."
          className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
        <span className="text-xs text-gray-500">共 {filtered.length} 个分区</span>
      </div>

      {/* table */}
      <div className="overflow-x-auto rounded-xl border border-gray-700">
        <table className="min-w-full text-xs">
          <thead>
            <tr className="bg-gray-900 border-b border-gray-700">
              {COLS.map(col => (
                <th
                  key={col.key}
                  className={`${col.w} px-3 py-2 text-left text-gray-400 font-semibold cursor-pointer select-none hover:text-gray-200 whitespace-nowrap`}
                  onClick={() => handleSort(col.key)}
                >
                  {col.label}
                  {sortKey === col.key && (
                    <span className="ml-1 text-blue-400">{sortDir === "asc" ? "▲" : "▼"}</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((p, i) => {
              const isSelected = p.index === selectedIdx;
              const isQualcomm = p.typeOs === "Qualcomm";
              return (
                <tr
                  key={p.index}
                  className={`border-b border-gray-800 cursor-pointer transition-colors
                    ${isSelected ? "bg-blue-900/40" : i % 2 === 0 ? "bg-gray-800/30 hover:bg-gray-700/40" : "bg-gray-800/10 hover:bg-gray-700/40"}
                    ${isQualcomm ? "border-l-2 border-l-blue-600" : ""}
                  `}
                  onClick={() => setSelectedIdx(isSelected ? null : p.index)}
                >
                  <td className="px-3 py-2 text-gray-500 font-mono">{p.index + 1}</td>
                  <td className="px-3 py-2 font-semibold text-white whitespace-nowrap">
                    {p.name || <span className="text-gray-600 italic">(无名)</span>}
                    {p.bootable && <span className="ml-1 text-yellow-400 text-[9px]">★BOOT</span>}
                  </td>
                  <td className="px-3 py-2 text-gray-300 whitespace-nowrap">{p.typeName}</td>
                  <td className="px-3 py-2"><OsBadge os={p.typeOs} /></td>
                  <td className="px-3 py-2 font-mono text-gray-300">{p.startLba.toString()}</td>
                  <td className="px-3 py-2 font-mono text-gray-300">{p.endLba.toString()}</td>
                  <td className="px-3 py-2 font-mono text-gray-400">{p.sizeSectors.toString()}</td>
                  <td className="px-3 py-2 text-green-300 font-semibold whitespace-nowrap">{p.sizeHuman}</td>
                  <td className="px-3 py-2 text-gray-400">{p.attributeDesc.join(", ")}</td>
                  <td className="px-3 py-2 font-mono text-gray-500 text-[10px] whitespace-nowrap">{p.typeGuid}</td>
                  <td className="px-3 py-2 font-mono text-gray-500 text-[10px] whitespace-nowrap">{p.uniqueGuid}</td>
                </tr>
              );
            })}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={COLS.length} className="px-4 py-8 text-center text-gray-500">
                  没有找到匹配的分区
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* detail panel */}
      {selectedPart && (
        <div className="mt-4 rounded-xl border border-blue-700/50 bg-blue-900/10 p-4">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-sm font-bold text-blue-300">
              分区详情: {selectedPart.name || `(分区 ${selectedPart.index + 1})`}
            </span>
            <OsBadge os={selectedPart.typeOs} />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-1 text-xs">
            <Detail label="分区名称" value={selectedPart.name} />
            <Detail label="类型名称" value={selectedPart.typeName} />
            <Detail label="操作系统" value={selectedPart.typeOs} />
            <Detail label="起始 LBA" value={`${selectedPart.startLba}  (偏移 ${lbaToOffset(selectedPart.startLba, sectorSize)})`} mono />
            <Detail label="结束 LBA" value={`${selectedPart.endLba}  (偏移 ${lbaToOffset(selectedPart.endLba, sectorSize)})`} mono />
            <Detail label="扇区数" value={selectedPart.sizeSectors.toString()} mono />
            <Detail label="分区大小" value={`${selectedPart.sizeHuman}  (${selectedPart.sizeBytes.toLocaleString()} 字节)`} />
            <Detail label="属性标志" value={`0x${selectedPart.attributes.toString(16).toUpperCase().padStart(16, "0")}`} mono />
            <Detail label="属性描述" value={selectedPart.attributeDesc.join(" | ")} />
            <Detail label="可启动" value={selectedPart.bootable ? "是" : "否"} />
            <Detail label="类型 GUID" value={selectedPart.typeGuid} mono colSpan />
            <Detail label="唯一 GUID" value={selectedPart.uniqueGuid} mono colSpan />
          </div>
        </div>
      )}
    </div>
  );
}

function Detail({
  label,
  value,
  mono,
  colSpan,
}: {
  label: string;
  value: string;
  mono?: boolean;
  colSpan?: boolean;
}) {
  return (
    <div className={`flex gap-2 items-baseline${colSpan ? " md:col-span-2" : ""}`}>
      <span className="text-gray-500 shrink-0 w-28">{label}:</span>
      <span className={`${mono ? "font-mono" : ""} text-gray-200 break-all`}>{value}</span>
    </div>
  );
}

// ─── Hex Dump ─────────────────────────────────────────────────────────────────

function HexDump({ hex }: { hex: string }) {
  return (
    <pre className="overflow-x-auto text-[11px] font-mono text-green-400 bg-gray-950 rounded-xl border border-gray-700 p-4 leading-5 whitespace-pre">
      {hex}
    </pre>
  );
}

// ─── Drop Zone ────────────────────────────────────────────────────────────────

function DropZone({
  onFile,
}: {
  onFile: (buf: ArrayBuffer, name: string) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(
    (file: File) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (reader.result instanceof ArrayBuffer) {
          onFile(reader.result, file.name);
        }
      };
      reader.readAsArrayBuffer(file);
    },
    [onFile]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile]
  );

  return (
    <div
      className={`relative rounded-2xl border-2 border-dashed transition-all duration-200 cursor-pointer
        ${dragging ? "border-blue-400 bg-blue-900/20 scale-[1.01]" : "border-gray-600 bg-gray-800/30 hover:border-gray-500 hover:bg-gray-800/50"}`}
      onDragOver={e => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".bin,.img,.mbn,.raw,*"
        className="hidden"
        onChange={e => {
          const file = e.target.files?.[0];
          if (file) handleFile(file);
          e.target.value = "";
        }}
      />
      <div className="py-14 text-center select-none">
        <div className="text-5xl mb-4">📦</div>
        <div className="text-lg font-semibold text-gray-300 mb-1">
          拖放 GPT 文件到此处，或点击选择文件
        </div>
        <div className="text-sm text-gray-500">
          支持格式：<code className="text-blue-400">gpt_main0.bin</code>、
          <code className="text-blue-400">gpt_both0.bin</code>、
          <code className="text-blue-400">gpt_backup0.bin</code>、
          <code className="text-blue-400">完整磁盘镜像</code>（eMMC / UFS）
        </div>
        <div className="text-xs text-gray-600 mt-2">
          所有解析均在本地浏览器完成，文件不会上传至任何服务器
        </div>
      </div>
    </div>
  );
}

// ─── Stats Bar ───────────────────────────────────────────────────────────────

function StatBadge({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-center bg-gray-800/60 border border-gray-700 rounded-xl px-4 py-2 min-w-[100px]">
      <span className="text-xs text-gray-500">{label}</span>
      <span className="text-sm font-bold text-white mt-0.5">{value}</span>
    </div>
  );
}

// ─── Tab ─────────────────────────────────────────────────────────────────────

function Tab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${
        active
          ? "bg-gray-800 text-white border-t border-l border-r border-gray-700"
          : "text-gray-400 hover:text-gray-200 bg-transparent"
      }`}
    >
      {children}
    </button>
  );
}

// ─── Format Guide ─────────────────────────────────────────────────────────────

function FormatGuide() {
  return (
    <div className="mt-6 rounded-xl border border-gray-700 bg-gray-800/30 p-6 text-sm text-gray-300">
      <h2 className="text-base font-bold text-white mb-4 flex items-center gap-2">
        <span>📖</span> 高通 GPT 文件格式说明
      </h2>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <h3 className="font-semibold text-blue-300 mb-2">文件类型</h3>
          <ul className="space-y-2 text-xs">
            <li><code className="text-yellow-300">gpt_main0.bin</code> — 主 GPT 分区表（Protective MBR + 主头 + 分区条目）</li>
            <li><code className="text-yellow-300">gpt_backup0.bin</code> — 备份 GPT（分区条目 + 备份头）</li>
            <li><code className="text-yellow-300">gpt_both0.bin</code> — 主 + 备份 GPT 合并文件（fastboot flash partition 使用）</li>
            <li><code className="text-yellow-300">PrimaryGPT_0.bin</code> — LG/HTC 固件中的主 GPT（与 gpt_main0.bin 相同）</li>
            <li><code className="text-yellow-300">*.img / *.bin</code> — 完整 eMMC / UFS 镜像，包含 GPT</li>
          </ul>
        </div>

        <div>
          <h3 className="font-semibold text-blue-300 mb-2">GPT 布局（512B 扇区，eMMC）</h3>
          <div className="font-mono text-xs space-y-0.5 bg-gray-900 rounded-lg p-3 border border-gray-700">
            <div><span className="text-gray-500">LBA 0</span>  <span className="text-orange-300">Protective MBR</span> <span className="text-gray-600">(512B)</span></div>
            <div><span className="text-gray-500">LBA 1</span>  <span className="text-green-300">主 GPT 头部</span> <span className="text-gray-600">(magic "EFI PART")</span></div>
            <div><span className="text-gray-500">LBA 2-33</span> <span className="text-blue-300">分区条目数组</span> <span className="text-gray-600">(128×128B = 16KB)</span></div>
            <div><span className="text-gray-500">LBA 34+</span> <span className="text-white">…… 数据分区 ……</span></div>
            <div><span className="text-gray-500">LBA -33</span> <span className="text-blue-300">备份分区条目</span></div>
            <div><span className="text-gray-500">LBA -1</span>  <span className="text-green-300">备份 GPT 头部</span></div>
          </div>
        </div>

        <div>
          <h3 className="font-semibold text-blue-300 mb-2">GPT 布局（4096B 扇区，UFS）</h3>
          <div className="font-mono text-xs space-y-0.5 bg-gray-900 rounded-lg p-3 border border-gray-700">
            <div><span className="text-gray-500">LBA 0</span>  <span className="text-orange-300">Protective MBR</span> <span className="text-gray-600">(4096B)</span></div>
            <div><span className="text-gray-500">LBA 1</span>  <span className="text-green-300">主 GPT 头部</span> <span className="text-gray-600">(magic 在偏移 4096)</span></div>
            <div><span className="text-gray-500">LBA 2-5</span>  <span className="text-blue-300">分区条目</span> <span className="text-gray-600">(128×128B = 4 扇区)</span></div>
            <div><span className="text-gray-500">LBA 6+</span>  <span className="text-white">…… 数据分区 ……</span></div>
          </div>
        </div>

        <div>
          <h3 className="font-semibold text-blue-300 mb-2">GPT 头部结构（共 92 字节）</h3>
          <div className="font-mono text-xs space-y-0.5 bg-gray-900 rounded-lg p-3 border border-gray-700">
            <div><span className="text-gray-500">0x00</span> <span className="text-white">8B</span>  <span className="text-yellow-300">签名 "EFI PART"</span></div>
            <div><span className="text-gray-500">0x08</span> <span className="text-white">4B</span>  <span className="text-gray-300">版本（00 00 01 00 = v1.0）</span></div>
            <div><span className="text-gray-500">0x0C</span> <span className="text-white">4B</span>  <span className="text-gray-300">头部大小（通常 92）</span></div>
            <div><span className="text-gray-500">0x10</span> <span className="text-white">4B</span>  <span className="text-red-300">头部 CRC32</span></div>
            <div><span className="text-gray-500">0x18</span> <span className="text-white">8B</span>  <span className="text-gray-300">当前 LBA</span></div>
            <div><span className="text-gray-500">0x20</span> <span className="text-white">8B</span>  <span className="text-gray-300">备份 LBA</span></div>
            <div><span className="text-gray-500">0x28</span> <span className="text-white">8B</span>  <span className="text-gray-300">首个可用 LBA</span></div>
            <div><span className="text-gray-500">0x30</span> <span className="text-white">8B</span>  <span className="text-gray-300">最后可用 LBA</span></div>
            <div><span className="text-gray-500">0x38</span> <span className="text-white">16B</span> <span className="text-green-300">磁盘 GUID（混合端序）</span></div>
            <div><span className="text-gray-500">0x48</span> <span className="text-white">8B</span>  <span className="text-gray-300">分区条目起始 LBA</span></div>
            <div><span className="text-gray-500">0x50</span> <span className="text-white">4B</span>  <span className="text-gray-300">分区条目数（通常 128）</span></div>
            <div><span className="text-gray-500">0x54</span> <span className="text-white">4B</span>  <span className="text-gray-300">条目大小（通常 128B）</span></div>
            <div><span className="text-gray-500">0x58</span> <span className="text-white">4B</span>  <span className="text-red-300">分区表 CRC32</span></div>
          </div>
        </div>
      </div>

      <div className="mt-4 text-xs text-gray-500 border-t border-gray-700 pt-3">
        <span className="text-blue-400">注意：</span>
        GUID 在二进制中使用混合端序存储：前 3 个部分（4B、2B、2B）为小端序，后 2 个部分（2B、6B）为大端序。
        分区名称使用 UTF-16LE 编码，最多 36 个字符（72 字节）。
        Qualcomm 特定属性位：bit 60 = 只读，bit 62 = 隐藏，bit 63 = 不自动挂载。
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────

type TabId = "partitions" | "header" | "hex" | "guide";

export default function App() {
  const [result, setResult] = useState<GptParseResult | null>(null);
  const [fileName, setFileName] = useState("");
  const [tab, setTab] = useState<TabId>("partitions");
  const [parsing, setParsing] = useState(false);

  const handleFile = useCallback((buf: ArrayBuffer, name: string) => {
    setParsing(true);
    setTimeout(() => {
      try {
        const r = parseGptImage(buf);
        setResult(r);
        setFileName(name);
        setTab("partitions");
      } catch (e) {
        console.error(e);
        setResult({
          fileSize: buf.byteLength,
          sectorSize: 512,
          detectedFormat: "Parse Error",
          primaryHeader: null,
          backupHeader: null,
          partitions: [],
          warnings: [],
          errors: [String(e)],
          hexDump: "",
        });
      }
      setParsing(false);
    }, 30);
  }, []);

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      {/* Header */}
      <header className="border-b border-gray-800 bg-gray-900/80 backdrop-blur sticky top-0 z-10">
        <div className="max-w-screen-xl mx-auto px-4 py-3 flex items-center gap-3">
          <div className="text-2xl">🔬</div>
          <div>
            <h1 className="text-base font-bold text-white leading-none">
              高通骁龙 GPT 分区表查看器
            </h1>
            <p className="text-xs text-gray-500 mt-0.5">
              Qualcomm Snapdragon GPT Partition Table Viewer
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2 text-xs text-gray-600">
            <span className="px-2 py-1 bg-blue-900/40 border border-blue-800 rounded text-blue-400">eMMC</span>
            <span className="px-2 py-1 bg-purple-900/40 border border-purple-800 rounded text-purple-400">UFS</span>
            <span className="px-2 py-1 bg-green-900/40 border border-green-800 rounded text-green-400">本地解析</span>
          </div>
        </div>
      </header>

      <main className="max-w-screen-xl mx-auto px-4 py-6">
        {/* Drop Zone */}
        {!result && !parsing && (
          <>
            <DropZone onFile={handleFile} />
            <FormatGuide />
          </>
        )}

        {parsing && (
          <div className="flex items-center justify-center py-32">
            <div className="text-center">
              <div className="text-4xl mb-4 animate-spin">⚙️</div>
              <div className="text-gray-400">正在解析 GPT 分区表…</div>
            </div>
          </div>
        )}

        {result && !parsing && (
          <div>
            {/* File info + re-open */}
            <div className="flex items-center gap-3 mb-4">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-white truncate">{fileName}</div>
                <div className="text-xs text-gray-500">
                  {(result.fileSize / 1024).toFixed(1)} KiB &nbsp;·&nbsp; {result.detectedFormat}
                </div>
              </div>
              <button
                onClick={() => { setResult(null); setFileName(""); }}
                className="px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg hover:bg-gray-700 transition-colors"
              >
                重新选择文件
              </button>
            </div>

            {/* Warnings & Errors */}
            {result.errors.map((e, i) => (
              <div key={i} className="mb-2 flex items-start gap-2 bg-red-900/20 border border-red-700 rounded-lg px-4 py-3 text-sm text-red-300">
                <span>❌</span><span>{e}</span>
              </div>
            ))}
            {result.warnings.map((w, i) => (
              <div key={i} className="mb-2 flex items-start gap-2 bg-yellow-900/20 border border-yellow-700 rounded-lg px-4 py-3 text-sm text-yellow-300">
                <span>⚠️</span><span>{w}</span>
              </div>
            ))}

            {/* Stats */}
            {result.primaryHeader && (
              <div className="flex flex-wrap gap-3 mb-5">
                <StatBadge label="扇区大小" value={`${result.sectorSize} 字节`} />
                <StatBadge label="分区数量" value={`${result.partitions.length}`} />
                <StatBadge label="磁盘 GUID" value={result.primaryHeader.diskGuid.slice(0, 13) + "…"} />
                <StatBadge label="首可用 LBA" value={result.primaryHeader.firstUsableLba.toString()} />
                <StatBadge label="末可用 LBA" value={result.primaryHeader.lastUsableLba.toString()} />
                <StatBadge label="条目大小" value={`${result.primaryHeader.partitionEntrySize} 字节`} />
                <StatBadge label="主头 CRC" value={result.primaryHeader.crcValid ? "✓ 正确" : "✗ 错误"} />
              </div>
            )}

            {/* Tabs */}
            <div className="border-b border-gray-700 flex gap-1 mb-0">
              <Tab active={tab === "partitions"} onClick={() => setTab("partitions")}>
                🗂️ 分区列表 ({result.partitions.length})
              </Tab>
              <Tab active={tab === "header"} onClick={() => setTab("header")}>
                📋 GPT 头部
              </Tab>
              <Tab active={tab === "hex"} onClick={() => setTab("hex")}>
                🔢 十六进制转储
              </Tab>
              <Tab active={tab === "guide"} onClick={() => setTab("guide")}>
                📖 格式说明
              </Tab>
            </div>

            <div className="border border-t-0 border-gray-700 rounded-b-xl bg-gray-800/20 p-4">
              {tab === "partitions" && (
                <PartitionTable partitions={result.partitions} sectorSize={result.sectorSize} />
              )}
              {tab === "header" && (
                <div className="space-y-4">
                  {result.primaryHeader && (
                    <HeaderCard header={result.primaryHeader} title="主 GPT 头部 (Primary)" sectorSize={result.sectorSize} />
                  )}
                  {result.backupHeader && (
                    <HeaderCard header={result.backupHeader} title="备份 GPT 头部 (Backup)" sectorSize={result.sectorSize} />
                  )}
                  {!result.primaryHeader && !result.backupHeader && (
                    <div className="text-gray-500 text-center py-8">未找到 GPT 头部</div>
                  )}
                </div>
              )}
              {tab === "hex" && (
                <div>
                  <p className="text-xs text-gray-500 mb-2">文件前 512 字节十六进制转储（含 Protective MBR 或 GPT 头部起始）</p>
                  <HexDump hex={result.hexDump} />
                </div>
              )}
              {tab === "guide" && <FormatGuide />}
            </div>

            {/* Partition visual map */}
            {result.primaryHeader && result.partitions.length > 0 && (
              <PartitionMap partitions={result.partitions} header={result.primaryHeader} sectorSize={result.sectorSize} />
            )}
          </div>
        )}
      </main>

      <footer className="border-t border-gray-800 mt-12 py-4 text-center text-xs text-gray-600">
        高通骁龙 GPT 分区表查看器 · 所有数据在本地浏览器处理，不会上传至任何服务器 · 支持 eMMC (512B) 和 UFS (4096B) 扇区
      </footer>
    </div>
  );
}

// ─── Partition Visual Map ─────────────────────────────────────────────────────

const PARTITION_COLORS = [
  "bg-blue-600",
  "bg-purple-600",
  "bg-green-600",
  "bg-yellow-600",
  "bg-red-600",
  "bg-pink-600",
  "bg-teal-600",
  "bg-orange-600",
  "bg-indigo-600",
  "bg-cyan-600",
  "bg-lime-600",
  "bg-rose-600",
];

function PartitionMap({
  partitions,
  header,
  sectorSize: _sectorSize,
}: {
  partitions: GptPartitionEntry[];
  header: GptHeader;
  sectorSize: number;
}) {
  const [hovered, setHovered] = useState<number | null>(null);

  const totalSectors = header.lastUsableLba - header.firstUsableLba + 1n;
  if (totalSectors <= 0n) return null;

  return (
    <div className="mt-6 rounded-xl border border-gray-700 bg-gray-800/30 p-5">
      <h2 className="text-sm font-bold text-gray-300 mb-4">📊 分区布局可视化</h2>
      <div className="flex h-10 rounded-lg overflow-hidden border border-gray-700 mb-4">
        {partitions.map((p, i) => {
          const pSize = p.endLba >= p.startLba ? p.endLba - p.startLba + 1n : 0n;
          const widthPct = Number((pSize * 10000n) / totalSectors) / 100;
          const color = PARTITION_COLORS[i % PARTITION_COLORS.length];
          if (widthPct < 0.05) return null;
          return (
            <div
              key={p.index}
              className={`${color} transition-opacity ${hovered !== null && hovered !== p.index ? "opacity-40" : "opacity-90"} relative overflow-hidden`}
              style={{ width: `${widthPct}%`, minWidth: widthPct > 1 ? "2px" : undefined }}
              onMouseEnter={() => setHovered(p.index)}
              onMouseLeave={() => setHovered(null)}
              title={`${p.name || "(无名)"}: ${p.sizeHuman}`}
            >
              {widthPct > 4 && (
                <span className="absolute inset-0 flex items-center justify-center text-[9px] font-bold text-white/90 truncate px-0.5">
                  {p.name || "?"}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-2 mt-3">
        {partitions.map((p, i) => {
          const color = PARTITION_COLORS[i % PARTITION_COLORS.length];
          return (
            <div
              key={p.index}
              className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs cursor-default transition-opacity ${hovered !== null && hovered !== p.index ? "opacity-40" : "opacity-100"}`}
              onMouseEnter={() => setHovered(p.index)}
              onMouseLeave={() => setHovered(null)}
            >
              <span className={`w-3 h-3 rounded-sm ${color} inline-block shrink-0`} />
              <span className="text-gray-300 font-medium">{p.name || `Part${p.index + 1}`}</span>
              <span className="text-gray-500">{p.sizeHuman}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
