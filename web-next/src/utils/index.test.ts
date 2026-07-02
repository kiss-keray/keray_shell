import { describe, expect, it } from "vitest";
import { deepClone, mapGet, treeList2Tree, uuid } from "@/utils";

describe("utils", () => {
    it("generates uuid with requested length", () => {
        expect(uuid(12)).toHaveLength(12);
    });

    it("maps flat list to tree", () => {
        const tree = treeList2Tree([
            { id: "root", name: "root" },
            { id: "child", parentId: "root", name: "child" },
        ]);
        expect(tree).toHaveLength(1);
        expect(tree[0].children?.[0].id).toBe("child");
    });

    it("reads nested values with mapGet", () => {
        const data = { users: [{ id: 1, name: "A" }] };
        expect(mapGet(data, "users[0].name")).toBe("A");
    });

    it("deep clones nested objects", () => {
        const source = { a: { b: 1 } };
        const cloned = deepClone(source) as typeof source;
        cloned.a.b = 2;
        expect(source.a.b).toBe(1);
    });

    it("installs Array.prototype.remove", () => {
        const values = [1, 2, 3];
        values.remove(2);
        expect(values).toEqual([1, 3]);
    });
});
