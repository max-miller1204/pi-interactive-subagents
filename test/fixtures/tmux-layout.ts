export function tmuxLayout(body: string): string {
	let checksum = 0;
	for (const character of body) {
		checksum = (checksum >>> 1) | ((checksum & 1) << 15);
		checksum = (checksum + character.charCodeAt(0)) & 0xffff;
	}
	return `${checksum.toString(16).padStart(4, "0")},${body}`;
}
