/**
 * Doorbells that pack two lenses into one stacked frame (main camera on top, package camera below, a black
 * band between). Viewers (Google Home, HomeKit tiles, the web UI) assume a landscape picture and squash or
 * crop a tall one, so both lenses are composed into a single 16:9 view: the main lens, with the package lens
 * inset over its bottom-left corner. That one view is what everything gets, including recording and object
 * detection.
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
        `[a]${MAIN_CROP},scale=1440:1080,pad=1920:1080:240:0:black[main]`,
        `[b]${PACKAGE_CROP},scale=640:348[pkg]`,
        '[main][pkg]overlay=0:732',
    ].join(';'),
    width: 1920,
    height: 1080,
};

const LAYOUTS: Record<string, LensView> = {
    T8213: DOORBELL_DUAL_INSET,
};

export function viewFor(sn: string): LensView | undefined {
    return LAYOUTS[sn.slice(0, 5)];
}
