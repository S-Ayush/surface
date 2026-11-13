// jsdom does no layout: ProseMirror's scrolling and coordinate lookups need these. Importing this
// file installs them.
const rect = { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 };
const noRects = Object.assign([], { item: () => null });

Range.prototype.getClientRects = () => noRects;
Range.prototype.getBoundingClientRect = () => ({ ...rect, toJSON: () => rect });
Element.prototype.getClientRects = () => noRects;
