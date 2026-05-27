import type { ChannelInstance } from "@/stores/channelInstances";

export type GroupLayoutOptions = {
    selectedBoxId: string;
    targetLandscapeRatio?: number;
    expandedWidth?: number;
    expandedHeight?: number;
    minChildWidth?: number;
};

/** 布局结果矩形 */
export type LayoutRect = {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    /** 为 true 表示当前为点击选中的「展开」主块 */
    fixed?: boolean;
};

/** 参与打包的项：id + 权重（通常用面积 origW*origH） */
type PackItemInput = {
    id: string;
    weight: number;
};

/** 内部布局节点：按权重换算后的目标面积 */
type AreaNode = {
    id: string;
    area: number;
};

/** 固定矩形外的剩余区域（左/右/上/下四块） */
type RegionName = "left" | "right" | "top" | "bottom";

type Region = {
    name: RegionName;
    x: number;
    y: number;
    width: number;
    height: number;
};

/** 行/列放置方向：horizontal=同一列宽、纵向叠放；vertical=同一行高、横向排列 */
type RowOrientation = "horizontal" | "vertical";

/** 终端分组面板上每个子块的规格（演示用随机尺寸） */
type BoxSpec = {
    id: string;
    origW: number;
    origH: number;
};

/** 保留两位小数的数值舍入 */
function round(n: number): number {
    return Math.round(n * 100) / 100;
}

/** 将 value 限制在 [min, max] */
function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

/**
 * 横向优先的矩形装箱器（Guillotine + 行贪心）。
 * 按权重分配面积，在行内尽量满足 targetLandscapeRatio。
 */
class LandscapePacker {
    private readonly W: number;
    private readonly H: number;
    private readonly minChildWidth: number;
    private readonly targetLandscapeRatio: number;

    constructor(containerWidth: number, containerHeight: number, minChildWidth: number, targetLandscapeRatio: number) {
        this.W = containerWidth;
        this.H = containerHeight;
        this.minChildWidth = minChildWidth;
        this.targetLandscapeRatio = targetLandscapeRatio;
    }

    /**
     * 将若干带权重的项打包进容器。
     * 1. 按权重比例分配总面积；
     * 2. 递归 _layout 切分容器并返回绝对坐标矩形。
     */
    pack(items: PackItemInput[]): LayoutRect[] {
        if (!items.length) return [];

        const totalWeight = items.reduce((s, it) => s + Math.max(it.weight, 1e-6), 0);
        const containerArea = this.W * this.H;
        const nodes: AreaNode[] = items.map((it) => ({
            id: it.id,
            area: (it.weight / totalWeight) * containerArea,
        }));

        return this._layout(nodes, 0, 0, this.W, this.H).map((r) => ({
            id: r.id,
            x: round(r.x),
            y: round(r.y),
            width: round(r.width),
            height: round(r.height),
        }));
    }

    /**
     * 在矩形 (x,y,w,h) 内递归布局 items。
     * 贪心组行：不断把最大项加入当前行，若加入后 worstLandscape 变差则换行；
     * 换行时按最优方向放置该行并收缩剩余区域，直到全部放完。
     */
    private _layout(items: AreaNode[], x: number, y: number, w: number, h: number): Array<Omit<LayoutRect, "fixed">> {
        items = [...items].sort((a, b) => b.area - a.area);
        const result: Array<Omit<LayoutRect, "fixed">> = [];
        let row: AreaNode[] = [];
        let remaining = items;

        while (remaining.length > 0) {
            const item = remaining[0];
            const candidate = [...row, item];
            // 首项必入队；否则比较「当前行」与「加入新项后」的最坏横向得分，更优才扩展行
            if (row.length === 0 || this._worstLandscape(row, w, h) >= this._worstLandscape(candidate, w, h)) {
                row = candidate;
                remaining = remaining.slice(1);
            } else {
                result.push(...this._flushRow(row, x, y, w, h));
                const orient = this._pickOrientation(row, w, h);
                const used = this._rowThickness(row, w, h, orient);
                // 水平行占满高度的一条带；垂直行占满宽度的一条带
                if (orient === "horizontal") {
                    y += used;
                    h -= used;
                } else {
                    x += used;
                    w -= used;
                }
                row = [];
            }
        }

        if (row.length) result.push(...this._flushRow(row, x, y, w, h));
        return result;
    }

    /** 确定行方向后，在 (x,y,w,h) 内放置整行并返回子矩形列表 */
    private _flushRow(row: AreaNode[], x: number, y: number, w: number, h: number): Array<Omit<LayoutRect, "fixed">> {
        const orient = this._pickOrientation(row, w, h);
        return this._placeRow(row, x, y, w, h, orient);
    }

    /** 判断当前行在指定方向下能否放入 (w,h)，并满足最小宽度约束 */
    private _rowFits(row: AreaNode[], w: number, h: number, orient: RowOrientation): boolean {
        const sum = row.reduce((s, it) => s + it.area, 0);
        if (orient === "horizontal") return w >= this.minChildWidth && sum / w <= h + 1e-6;
        return sum / h <= w + 1e-6 && row.every((it) => it.area / h >= this.minChildWidth);
    }

    /**
     * 在可行方向中选横向惩罚更小者；
     * 若仅一侧可行则选该侧；都不可行时默认 horizontal（后续可能溢出，由上层 fallback）。
     */
    private _pickOrientation(row: AreaNode[], w: number, h: number): RowOrientation {
        const fitsH = this._rowFits(row, w, h, "horizontal");
        const fitsV = this._rowFits(row, w, h, "vertical");
        if (!fitsH && !fitsV) return "horizontal";
        if (fitsH && !fitsV) return "horizontal";
        if (!fitsH && fitsV) return "vertical";
        return this._worstLandscapeOrient(row, w, h, "horizontal") <= this._worstLandscapeOrient(row, w, h, "vertical") ? "horizontal" : "vertical";
    }

    /** 对一行在所有可行方向上的 worstLandscapeOrient 取最小值，用于贪心比较 */
    private _worstLandscape(row: AreaNode[], w: number, h: number): number {
        const scores: number[] = [];
        if (this._rowFits(row, w, h, "horizontal")) {
            scores.push(this._worstLandscapeOrient(row, w, h, "horizontal"));
        }
        if (this._rowFits(row, w, h, "vertical")) {
            scores.push(this._worstLandscapeOrient(row, w, h, "vertical"));
        }
        return scores.length ? Math.min(...scores) : Infinity;
    }

    /** 一行在某方向下，各子块宽高比惩罚的最大值（越大越差） */
    private _worstLandscapeOrient(row: AreaNode[], w: number, h: number, orient: RowOrientation): number {
        let worst = 0;
        if (orient === "horizontal") {
            for (const it of row) {
                const ih = it.area / w;
                worst = Math.max(worst, this._penalty(w / ih));
            }
        } else {
            for (const it of row) {
                const iw = it.area / h;
                if (iw < this.minChildWidth) return Infinity;
                worst = Math.max(worst, this._penalty(iw / h));
            }
        }
        return worst;
    }

    /**
     * 宽高比惩罚：纵向块（ratio<1）重罚；
     * 横向在 TARGET 附近对数平滑；过大比例线性加重。
     */
    private _penalty(ratio: number): number {
        if (ratio < 1) return 1e6 * (1 / Math.max(ratio, 0.01));
        const t = this.targetLandscapeRatio;
        if (ratio <= t * 2) return 1 + Math.abs(Math.log(ratio / t));
        return 1 + Math.log(ratio / t);
    }

    /** 行占用的厚度：horizontal 为行高 sum/w，vertical 为行宽 sum/h */
    private _rowThickness(row: AreaNode[], w: number, h: number, orient: RowOrientation): number {
        const sum = row.reduce((s, it) => s + it.area, 0);
        return orient === "horizontal" ? sum / w : sum / h;
    }

    /** 按方向将一行内各项依次贴放，共享列宽 w 或行高 h */
    private _placeRow(row: AreaNode[], x: number, y: number, w: number, h: number, orient: RowOrientation): Array<Omit<LayoutRect, "fixed">> {
        const rects: Array<Omit<LayoutRect, "fixed">> = [];
        if (orient === "horizontal") {
            let cy = y;
            for (const it of row) {
                const ih = it.area / w;
                rects.push({ id: it.id, x, y: cy, width: w, height: ih });
                cy += ih;
            }
        } else {
            let cx = x;
            for (const it of row) {
                const iw = it.area / h;
                rects.push({ id: it.id, x: cx, y, width: iw, height: h });
                cx += iw;
            }
        }
        return rects;
    }
}

/** 回退布局：每项占满容器宽度，高度按权重比例分配（最后一项吃掉剩余高度）。 */
function packHorizontalRows(items: PackItemInput[], width: number, height: number): LayoutRect[] {
    const totalWeight = items.reduce((sum, item) => sum + Math.max(item.weight, 1e-6), 0);
    let y = 0;
    return items.map((item, index) => {
        const isLast = index === items.length - 1;
        const itemHeight = isLast ? height - y : (Math.max(item.weight, 1e-6) / totalWeight) * height;
        const layout: LayoutRect = {
            id: item.id,
            x: 0,
            y: round(y),
            width: round(width),
            height: round(itemHeight),
        };
        y += itemHeight;
        return layout;
    });
}

/**
 * 对外打包入口：优先 LandscapePacker；
 * 若任一子块宽度 < minChildWidth，则回退为按权重纵向切条的简单布局。
 */
function packItems(
    items: PackItemInput[],
    width: number,
    height: number,
    minChildWidth: number,
    targetLandscapeRatio: number,
): LayoutRect[] {
    const layouts = new LandscapePacker(width, height, minChildWidth, targetLandscapeRatio).pack(items);
    if (layouts.every((layout) => layout.width >= minChildWidth)) {
        return layouts;
    }
    return packHorizontalRows(items, width, height);
}

/**
 * 按区域面积比例将 totalItems 个名额分配到各区域（最大余额法取整 + 修正超配/欠配）。
 */
function allocateRegionCounts(totalItems: number, regions: Region[]): number[] {
    const totalArea = regions.reduce((sum, region) => sum + region.width * region.height, 0);
    const quotas = regions.map((region, index) => {
        const quota = ((region.width * region.height) / totalArea) * totalItems;
        return { index, quota, count: Math.floor(quota) };
    });
    let assigned = quotas.reduce((sum, item) => sum + item.count, 0);

    quotas
        .sort((a, b) => b.quota - b.count - (a.quota - a.count))
        .forEach((item) => {
            if (assigned < totalItems) {
                item.count += 1;
                assigned += 1;
            }
        });

    while (assigned > totalItems) {
        const item = quotas.filter((quota) => quota.count > 0).sort((a, b) => a.quota - (a.count - 1) - (b.quota - (b.count - 1)))[0];
        item.count -= 1;
        assigned -= 1;
    }

    return quotas.sort((a, b) => a.index - b.index).map((item) => item.count);
}

/**
 * 在 available 集合中找 baseLayouts 中心离 region 中心最近的一项 id。
 */
function findNearestAvailable(specs: BoxSpec[], available: Set<string>, baseMap: Map<string, LayoutRect>, region: Region): string | null {
    const regionCenterX = region.x + region.width / 2;
    const regionCenterY = region.y + region.height / 2;
    let bestId: string | null = null;
    let bestDistance = Infinity;
    for (const spec of specs) {
        if (!available.has(spec.id)) continue;
        const base = baseMap.get(spec.id);
        const centerX = base ? base.x + base.width / 2 : regionCenterX;
        const centerY = base ? base.y + base.height / 2 : regionCenterY;
        const distance = (centerX - regionCenterX) ** 2 + (centerY - regionCenterY) ** 2;
        if (distance < bestDistance) {
            bestDistance = distance;
            bestId = spec.id;
        }
    }
    return bestId;
}

/**
 * 计算固定矩形外的左、右、上、下四块剩余区域。
 * includeTooNarrow 为 true 时不过滤宽度 < minChildWidth 的条带（用于扩张阶段）。
 */
function getRemainingRegions(fixedRect: LayoutRect, outerW: number, outerH: number, minChildWidth: number, includeTooNarrow = false): Region[] {
    const rightX = fixedRect.x + fixedRect.width;
    const bottomY = fixedRect.y + fixedRect.height;
    const allRegions: Region[] = [
        { name: "left", x: 0, y: 0, width: fixedRect.x, height: outerH },
        { name: "right", x: rightX, y: 0, width: outerW - rightX, height: outerH },
        { name: "top", x: fixedRect.x, y: 0, width: fixedRect.width, height: fixedRect.y },
        { name: "bottom", x: fixedRect.x, y: bottomY, width: fixedRect.width, height: outerH - bottomY },
    ];
    return allRegions.filter((region) => {
        return region.width > 1 && region.height > 1 && (includeTooNarrow || region.width >= minChildWidth);
    });
}

/**
 * 迭代吞并固定块四周「无法有效分给其它项」的窄条区域，使展开块尽量占满可用空间。
 * 最多 4 轮；无其它项时直接铺满整个容器。
 */
function growFixedRectIntoUnusedRegions(rect: LayoutRect, outerW: number, outerH: number, otherCount: number, minChildWidth: number): LayoutRect {
    const grown: LayoutRect = { ...rect };
    if (!otherCount) {
        return {
            ...grown,
            x: 0,
            y: 0,
            width: outerW,
            height: outerH,
        };
    }

    for (let i = 0; i < 4; i += 1) {
        const regions = getRemainingRegions(grown, outerW, outerH, minChildWidth, true);
        if (!regions.length) break;

        const counts = allocateRegionCounts(otherCount, regions);
        let changed = false;
        regions.forEach((region, index) => {
            if (counts[index] !== 0 && region.width >= minChildWidth) return;
            if (region.name === "top") {
                grown.height += grown.y;
                grown.y = 0;
                changed = true;
            } else if (region.name === "bottom") {
                grown.height = outerH - grown.y;
                changed = true;
            } else if (region.name === "left") {
                grown.width += grown.x;
                grown.x = 0;
                changed = true;
            } else if (region.name === "right") {
                grown.width = outerW - grown.x;
                changed = true;
            }
        });

        if (!changed) break;
    }

    return {
        ...grown,
        x: round(grown.x),
        y: round(grown.y),
        width: round(grown.width),
        height: round(grown.height),
    };
}

/**
 * 评估固定矩形位置的质量（分数越低越好）。
 */
function scoreFixedRect(
    rect: LayoutRect,
    selectedBase: LayoutRect,
    outerW: number,
    outerH: number,
    otherCount: number,
    minChildWidth: number,
): number {
    if (!otherCount) return 0;
    rect = growFixedRectIntoUnusedRegions(rect, outerW, outerH, otherCount, minChildWidth);
    const regions = getRemainingRegions(rect, outerW, outerH, minChildWidth);
    const counts = allocateRegionCounts(otherCount, regions);
    const areas = regions
        .map((region, index) => {
            if (!counts[index]) return null;
            return (region.width * region.height) / counts[index];
        })
        .filter((area): area is number => area !== null);
    if (!areas.length) return Infinity;

    const fairnessRatio = Math.max(...areas) / Math.max(Math.min(...areas), 1);
    const unusedArea = regions.reduce((sum, region, index) => {
        return counts[index] ? sum : sum + region.width * region.height;
    }, 0);
    const totalArea = regions.reduce((sum, region) => sum + region.width * region.height, 0);
    const oldCenterX = selectedBase.x + selectedBase.width / 2;
    const oldCenterY = selectedBase.y + selectedBase.height / 2;
    const newCenterX = rect.x + rect.width / 2;
    const newCenterY = rect.y + rect.height / 2;
    const distance = Math.hypot(newCenterX - oldCenterX, newCenterY - oldCenterY);
    const distancePenalty = distance / Math.max(outerW, outerH);

    return fairnessRatio + (unusedArea / Math.max(totalArea, 1)) * 2 + distancePenalty * 0.08;
}

/**
 * 为选中块在容器内选取固定尺寸矩形的位置。
 */
function chooseFixedRect(
    id: string,
    selectedBase: LayoutRect,
    fixedWidth: number,
    fixedHeight: number,
    outerW: number,
    outerH: number,
    otherCount: number,
    minChildWidth: number,
): LayoutRect {
    const baseCenterX = selectedBase.x + selectedBase.width / 2;
    const baseCenterY = selectedBase.y + selectedBase.height / 2;
    const containerCenterX = outerW / 2;
    const containerCenterY = outerH / 2;
    const maxX = Math.max(0, outerW - fixedWidth);
    const maxY = Math.max(0, outerH - fixedHeight);
    const candidates: Array<{ x: number; y: number }> = [];
    const seen = new Set<string>();

    [0, 0.35, 0.7, 1].forEach((xBias) => {
        [0, 0.35, 0.7, 1].forEach((yBias) => {
            const centerX = baseCenterX + (containerCenterX - baseCenterX) * xBias;
            const centerY = baseCenterY + (containerCenterY - baseCenterY) * yBias;
            const x = round(clamp(centerX - fixedWidth / 2, 0, maxX));
            const y = round(clamp(centerY - fixedHeight / 2, 0, maxY));
            const key = `${x},${y}`;
            if (!seen.has(key)) {
                seen.add(key);
                candidates.push({ x, y });
            }
        });
    });

    const best = candidates
        .map((candidate) => {
            const rect: LayoutRect = {
                id,
                x: candidate.x,
                y: candidate.y,
                width: fixedWidth,
                height: fixedHeight,
                fixed: true,
            };
            return {
                rect,
                score: scoreFixedRect(rect, selectedBase, outerW, outerH, otherCount, minChildWidth),
            };
        })
        .sort((a, b) => a.score - b.score)[0];

    return best.rect;
}

/**
 * 将 specs 按区域面积配额分配到各 bucket，并在每个区域内选「离区域中心最近」的项。
 */
function distributeFairly(specs: BoxSpec[], regions: Region[], baseLayouts: LayoutRect[]): BoxSpec[][] {
    if (!regions.length) return [];
    const counts = allocateRegionCounts(specs.length, regions);
    const buckets: BoxSpec[][] = regions.map(() => []);
    const baseMap = new Map(baseLayouts.map((layout) => [layout.id, layout]));
    const available = new Set(specs.map((spec) => spec.id));
    const regionOrder = regions.map((region, index) => ({ region, index })).sort((a, b) => counts[b.index] - counts[a.index]);

    for (const { region, index } of regionOrder) {
        while (buckets[index].length < counts[index] && available.size) {
            const bestId = findNearestAvailable(specs, available, baseMap, region);
            if (bestId === null) break;
            available.delete(bestId);
            const spec = specs.find((s) => s.id === bestId);
            if (spec) buckets[index].push(spec);
        }
    }

    return buckets;
}

function randomBoxSize(): [number, number] {
    const w = 80 + Math.random() * 120;
    const h = 35 + Math.random() * 50;
    return [Math.round(w), Math.round(h)];
}

export class GroupLayout {
    /** 目标宽高比 width/height，布局算法尽量让子块接近该横向比例 */
    private readonly targetLandscapeRatio: number;
    /** 点击选中后展开块的默认宽度（像素，会与容器取 min） */
    private readonly expandedWidth: number;
    /** 点击选中后展开块的默认高度 */
    private readonly expandedHeight: number;
    /** 子块最小宽度，低于此值则回退到简单横向分行布局 */
    private readonly minChildWidth: number;
    /** 选中的块id */
    private selectedBoxId: string;

    private boxSpecs: BoxSpec[] = [];

    constructor({ selectedBoxId, targetLandscapeRatio = 1.2, expandedWidth = 1000, expandedHeight = 800, minChildWidth = 100 }: GroupLayoutOptions) {
        this.selectedBoxId = selectedBoxId;
        this.targetLandscapeRatio = targetLandscapeRatio;
        this.expandedWidth = expandedWidth;
        this.expandedHeight = expandedHeight;
        this.minChildWidth = minChildWidth;
    }

    /**
     * 构建最终布局：无选中时返回权重打包结果；
     * 有选中时固定展开块，其余项在剩余区域内二次 packItems 并平移到区域坐标。
     */
    private buildClickLayout(outerW: number, outerH: number): LayoutRect[] {
        const { minChildWidth, targetLandscapeRatio } = this;
        const baseLayouts = packItems(
            this.boxSpecs.map((s) => ({ id: s.id, weight: s.origW * s.origH })),
            outerW,
            outerH,
            minChildWidth,
            targetLandscapeRatio,
        );
        if (this.selectedBoxId === null || !this.boxSpecs.some((s) => s.id === this.selectedBoxId)) {
            return baseLayouts;
        }

        const selectedBase = baseLayouts.find((layout) => layout.id === this.selectedBoxId);
        if (!selectedBase) return baseLayouts;

        const fixedWidth = Math.min(this.expandedWidth, outerW);
        const fixedHeight = Math.min(this.expandedHeight, outerH);
        const otherSpecs = this.boxSpecs.filter((spec) => spec.id !== this.selectedBoxId);
        const fixedRect = chooseFixedRect(this.selectedBoxId, selectedBase, fixedWidth, fixedHeight, outerW, outerH, otherSpecs.length, minChildWidth);
        const grownFixedRect = growFixedRectIntoUnusedRegions(fixedRect, outerW, outerH, otherSpecs.length, minChildWidth);
        if (!otherSpecs.length) return [grownFixedRect];

        const regions = getRemainingRegions(grownFixedRect, outerW, outerH, minChildWidth);
        const buckets = distributeFairly(otherSpecs, regions, baseLayouts);
        const result: LayoutRect[] = [grownFixedRect];

        regions.forEach((region, index) => {
            const bucket = buckets[index];
            if (!bucket.length) return;
            const packed = packItems(
                bucket.map((spec) => ({ id: spec.id, weight: 1 })),
                region.width,
                region.height,
                minChildWidth,
                targetLandscapeRatio,
            );
            packed.forEach((layout) => {
                result.push({
                    id: layout.id,
                    x: round(layout.x + region.x),
                    y: round(layout.y + region.y),
                    width: layout.width,
                    height: layout.height,
                });
            });
        });

        return result.sort((a, b) => a.id.localeCompare(b.id));
    }

    layoutInit(instances: ChannelInstance[], outerW: number, outerH: number): LayoutRect[] {
        this.boxSpecs = instances.map((v) => {
            const [origW, origH] = randomBoxSize();
            return { id: v.sessionId, origW, origH };
        });
        return this.buildClickLayout(outerW, outerH);
    }

    changeSelectedBoxId(selectedBoxId: string, outerW: number, outerH: number): LayoutRect[] {
        this.selectedBoxId = selectedBoxId;
        return this.buildClickLayout(outerW, outerH);
    }

    layoutUpdate(outerW: number, outerH: number): LayoutRect[] {
        return this.buildClickLayout(outerW, outerH);
    }
}
