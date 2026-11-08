/**
 * Quad class representing a 3x3 matrix for quadratic optimization
 */
export default class Quad {
    constructor() {
        this.data = [
            0, 0, 0,
            0, 0, 0,
            0, 0, 0
        ];
    }
    at(x, y) {
        return this.data[x * 3 + y];
    }
}
