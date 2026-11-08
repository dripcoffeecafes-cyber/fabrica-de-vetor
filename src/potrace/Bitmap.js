import Point from './Point.js';
/**
 * Bitmap class for storing binary image data
 * This is the main input for the tracing algorithm
 */
export default class Bitmap {
    constructor(width, height) {
        this.width = width;
        this.height = height;
        this.size = width * height;
        this.data = new Int8Array(this.size);
    }
    /**
     * Check if pixel at (x, y) is set (black/foreground)
     */
    at(x, y) {
        return (x >= 0 && x < this.width && y >= 0 && y < this.height) &&
            this.data[this.width * y + x] === 1;
    }
    /**
     * Toggle pixel at (x, y)
     */
    flip(x, y) {
        if (this.at(x, y)) {
            this.data[this.width * y + x] = 0;
        }
        else {
            this.data[this.width * y + x] = 1;
        }
    }
    /**
     * Create a copy of this bitmap
     */
    copy() {
        const bitmap = new Bitmap(this.width, this.height);
        for (let i = 0; i < this.size; i++) {
            bitmap.data[i] = this.data[i];
        }
        return bitmap;
    }
    /**
     * Convert flat index to Point
     */
    index(i) {
        const x = i % this.width;
        const y = Math.floor(i / this.width);
        return new Point(x, y);
    }
    /**
     * XOR a path with the bitmap
     */
    xOrPath(path) {
        let y1 = path.points[0].y;
        for (let i = 1; i < path.points.length; i++) {
            const x = path.points[i].x;
            const y = path.points[i].y;
            if (y !== y1) {
                const minY = Math.min(y1, y);
                const maxX = path.maxX;
                for (let j = x; j < maxX; j++) {
                    this.flip(j, minY);
                }
                y1 = y;
            }
        }
    }
}
