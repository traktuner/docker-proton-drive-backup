/** Day-of-week labels in JS getDay() index order (0 = Sunday). */
export const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Display order Mon→Sun (values stay JS getDay indices: 0=Sun..6=Sat). */
export const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0];

/** Zero-pad a number to two digits (e.g. HH / MM). */
export const pad = (n: number) => String(n).padStart(2, '0');
