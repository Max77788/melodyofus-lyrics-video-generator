import React from 'react';
import { Composition } from 'remotion';
import { CaptionVideo } from './CaptionVideo';

// Default props - will be overridden at render time via inputProps
const DEFAULT_DURATION_FRAMES = 30 * 30; // 30s at 30fps fallback

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="CaptionVideo"
        component={CaptionVideo}
        durationInFrames={DEFAULT_DURATION_FRAMES}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={{
          videoUrl: '',
          audioUrl: '',
          captions: [],
          songName: '',
        }}
        calculateMetadata={async ({ props }) => {
          // Duration is passed in via inputProps.durationInFrames
          return {
            durationInFrames:
              typeof props.durationInFrames === 'number'
                ? props.durationInFrames
                : DEFAULT_DURATION_FRAMES,
            fps: 30,
            width: 1080,
            height: 1920,
          };
        }}
      />
    </>
  );
};
