import React from 'react';
import { AbsoluteFill, Audio, Sequence, Video } from 'remotion';
import { AnimatedCaptions } from './AnimatedCaptions';

export interface CaptionVideoProps extends Record<string, unknown> {
  videoUrl: string;
  audioUrl: string;
  captions: Array<{ index: number; start: number; end: number; text: string }>;
  songName?: string;
  durationInFrames?: number;
}

export const CaptionVideo: React.FC<CaptionVideoProps> = ({
  videoUrl,
  audioUrl,
  captions,
  songName,
}) => {
  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      {/* Background video - muted, we use separate audio */}
      <Video
        src={videoUrl}
        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        muted
      />

      {/* Audio track */}
      <Audio src={audioUrl} />

      {/* Static song title: never animated and always visible */}
      {songName ? (
        <Sequence from={0}>
          <div
            style={{
              position: 'absolute',
              top: 230,
              left: '50%',
              width: 'min(92%, 940px)',
              transform: 'translateX(-50%)',
              display: 'flex',
              justifyContent: 'center',
              pointerEvents: 'none',
              zIndex: 20,
              paddingLeft: 32,
              paddingRight: 32,
            }}
          >
            <span
              style={{
                fontFamily: '"Times New Roman", Georgia, serif',
                fontWeight: 700,
                fontSize: 42,
                letterSpacing: 0.6,
                textTransform: 'uppercase',
                // Distinct title color so it always differs from white lyric captions.
                color: '#67E8F9',
                textShadow: '0 2px 14px rgba(0,0,0,0.7)',
                lineHeight: 1.2,
                display: 'inline-block',
                maxWidth: 860,
                whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere',
                textAlign: 'center',
                background: 'rgba(8,8,8,0.28)',
                border: '1px solid rgba(103,232,249,0.6)',
                borderRadius: 12,
                padding: '10px 24px',
              }}
            >
              {songName}
            </span>
          </div>
        </Sequence>
      ) : null}

      {/* Animated captions overlay */}
      <AnimatedCaptions captions={captions} />
    </AbsoluteFill>
  );
};
