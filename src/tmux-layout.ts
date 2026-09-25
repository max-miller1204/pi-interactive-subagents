export type LayoutCell = {
	width: number;
	height: number;
	left: number;
	top: number;
} & (
	| { kind: "pane"; paneId: string }
	| { kind: "horizontal" | "vertical"; children: LayoutCell[] }
);

// tmux layouts use a rotating 16-bit checksum followed by a cell tree.
export function parseTmuxLayout(output: string): LayoutCell {
	const text = output.endsWith("\n") ? output.slice(0, -1) : output;
	if (!/^[0-9a-f]{4},/.test(text))
		throw new Error("Malformed tmux layout checksum.");
	const body = text.slice(5);
	let checksum = 0;
	for (const character of body) {
		checksum = (checksum >>> 1) | ((checksum & 1) << 15);
		checksum = (checksum + character.charCodeAt(0)) & 0xffff;
	}
	if (checksum !== Number.parseInt(text.slice(0, 4), 16))
		throw new Error("Tmux layout checksum mismatch.");
	let position = 0;
	const panes = new Set<string>();
	const number = (positive: boolean): number => {
		const match = /^(0|[1-9][0-9]*)/.exec(body.slice(position));
		if (match === null) throw new Error("Malformed tmux layout number.");
		position += match[0].length;
		const value = Number(match[0]);
		if (!Number.isSafeInteger(value) || (positive && value === 0))
			throw new Error("Invalid tmux layout size or coordinate.");
		return value;
	};
	const token = (expected: string): void => {
		if (body[position++] !== expected)
			throw new Error("Malformed tmux layout tree.");
	};
	const cell = (): LayoutCell => {
		const width = number(true);
		token("x");
		const height = number(true);
		token(",");
		const left = number(false);
		token(",");
		const top = number(false);
		if (
			!Number.isSafeInteger(left + width) ||
			!Number.isSafeInteger(top + height)
		)
			throw new Error("Invalid tmux layout bounds.");
		const next = body[position++];
		if (next === ",") {
			const paneId = `%${number(false)}`;
			if (panes.has(paneId)) throw new Error("Duplicate pane in tmux layout.");
			panes.add(paneId);
			return { width, height, left, top, kind: "pane", paneId };
		}
		if (next !== "{" && next !== "[")
			throw new Error("Malformed tmux layout cell.");
		const kind = next === "{" ? "horizontal" : "vertical";
		const end = next === "{" ? "}" : "]";
		const children = [cell()];
		while (body[position] === ",") {
			position++;
			children.push(cell());
		}
		token(end);
		if (children.length < 2)
			throw new Error("Tmux layout container needs two cells.");
		let offset = kind === "horizontal" ? left : top;
		for (const child of children) {
			if (
				kind === "horizontal"
					? child.left !== offset ||
						child.top !== top ||
						child.height !== height
					: child.top !== offset || child.left !== left || child.width !== width
			)
				throw new Error("Tmux layout cells do not partition their container.");
			offset += (kind === "horizontal" ? child.width : child.height) + 1;
		}
		if (offset - 1 !== (kind === "horizontal" ? left + width : top + height))
			throw new Error("Tmux layout cells do not fill their container.");
		return { width, height, left, top, kind, children };
	};
	const root = cell();
	if (position !== body.length)
		throw new Error("Trailing data in tmux layout.");
	return root;
}

export function layoutPanes(
	cell: LayoutCell,
): (LayoutCell & { kind: "pane" })[] {
	return cell.kind === "pane" ? [cell] : cell.children.flatMap(layoutPanes);
}

export function isolatedColumn(
	root: LayoutCell,
	ids: string[],
): LayoutCell & { kind: "vertical" | "horizontal" } {
	const visit = (
		cell: LayoutCell,
	): (LayoutCell & { kind: "vertical" | "horizontal" }) | undefined => {
		if (cell.kind === "pane") return undefined;
		if (
			cell.kind === "vertical" &&
			cell.children.length === ids.length &&
			cell.children.every(
				(child) => child.kind === "pane" && ids.includes(child.paneId),
			)
		)
			return cell;
		for (const child of cell.children) {
			const found = visit(child);
			if (found !== undefined) return found;
		}
		return undefined;
	};
	const column = visit(root);
	if (column === undefined)
		throw new Error("Child panes do not form an isolated column subtree.");
	return column;
}
