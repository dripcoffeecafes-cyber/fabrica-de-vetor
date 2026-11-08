/**
 * Path class representing a traced path
 */
export default class Path {
    constructor(points, area, isHole) {
        this.points = points;
        this.area = area;
        this.isHole = isHole;
        // (patch) laço em vez de Math.min(...arr): evita estouro de argumentos em contornos enormes (Safari)
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let i = 0; i < points.length; i++) {
            const p = points[i];
            if (p.x < minX) minX = p.x;
            if (p.x > maxX) maxX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.y > maxY) maxY = p.y;
        }
        this.minX = minX; this.minY = minY; this.maxX = maxX; this.maxY = maxY;
        this.curve = {};
    }
    reverse() {
        if (this.curve && this.curve.vertex) {
            this.curve.vertex.reverse();
        }
    }
}
