/**
 * A 2D point class used throughout potrace
 */
export default class Point {
    constructor(x = 0, y = 0) {
        this.x = x;
        this.y = y;
    }
    copy() {
        return new Point(this.x, this.y);
    }
    toIndex(width, height) {
        if (this.x < 0 || this.y < 0 || this.x >= width || this.y >= height)
            return null;
        return width * this.y + this.x;
    }
    lerp(point, lambda) {
        const x = this.x + lambda * (point.x - this.x);
        const y = this.y + lambda * (point.y - this.y);
        return new Point(x, y);
    }
    dorthInfty(point) {
        const x = -sign(point.y - this.y);
        const y = sign(point.x - this.x);
        return new Point(x, y);
    }
    ddenom(point) {
        const r = this.dorthInfty(point);
        return r.y * (point.x - this.x) - r.x * (point.y - this.y);
    }
    dpara(p1, p2) {
        const x1 = p1.x - this.x;
        const y1 = p1.y - this.y;
        const x2 = p2.x - this.x;
        const y2 = p2.y - this.y;
        return x1 * y2 - x2 * y1;
    }
    interval(p1, p2) {
        const denom = this.ddenom(p2);
        if (denom === 0)
            return 10000000;
        return -this.dpara(p1, p2) / denom;
    }
    subtract(p) {
        return new Point(this.x - p.x, this.y - p.y);
    }
    add(p) {
        return new Point(this.x + p.x, this.y + p.y);
    }
    multiply(s) {
        return new Point(this.x * s, this.y * s);
    }
    dot(p) {
        return this.x * p.x + this.y * p.y;
    }
    cross(p) {
        return this.x * p.y - this.y * p.x;
    }
}
function sign(i) {
    return i > 0 ? 1 : i < 0 ? -1 : 0;
}
