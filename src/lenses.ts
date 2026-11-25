/**
 * Doorbells that pack two lenses into one stacked frame (main camera on top, package camera below, a black
 * band between). Viewers (Google Home, HomeKit tiles, the web UI) assume a landscape picture and squash or
 * crop a tall one, so both lenses are composed into a single 16:9 view, neither lens cropped: the main lens
 * flush left at full height (the driveway, where number plates are, stays clear), and the package lens in the
 * bottom-right, using the spare width and overlapping only the brick wall at the main lens's right edge.
 * That one view is what everything gets, including recording and object detection.
 *
 * Crops are proportional to the camera frame height because the camera steps its resolution up and down
 * mid-session, and the output is a fixed size so those steps never reach the viewer.
 */
export interface LensView {
    id: string;
    name: string;
    /** ffmpeg filtergraph from the camera frame to this view. */
    filter: string;
    width: number;
    height: number;
}

// Video Doorbell Dual (T8213), measured on a 1600x2300 frame: main 0-1199, black band 1200-1429, package 1430-2299.
const MAIN_CROP = 'crop=iw:ih*1200/2300:0:0';
const PACKAGE_CROP = 'crop=iw:ih*870/2300:0:ih*1430/2300';

const DOORBELL_DUAL_INSET: LensView = {
    id: 'combined',
    name: 'Doorbell',
    filter: [
        'split[a][b]',
        `[a]${MAIN_CROP},scale=1600:1200,pad=2134:1200:0:0:black[main]`,
        `[b]${PACKAGE_CROP},scale=868:472[pkg]`,
        '[main][pkg]overlay=1266:728',
    ].join(';'),
    // 16:9 sized to the main lens's native 1600x1200, so the main lens is never scaled.
    width: 2134,
    height: 1200,
};

const LAYOUTS: Record<string, LensView> = {
    T8213: DOORBELL_DUAL_INSET,
};

export function viewFor(sn: string): LensView | undefined {
    return LAYOUTS[sn.slice(0, 5)];
}
