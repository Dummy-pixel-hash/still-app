import React from 'react';
import {AbsoluteFill, useVideoConfig} from 'remotion';
import type {TransitionPresentation, TransitionPresentationComponentProps} from '@remotion/transitions';

type RevealProps = {direction:'from-right'|'from-top'|'from-bottom'; feather:number};

const SoftReveal:React.FC<TransitionPresentationComponentProps<RevealProps>> = ({children,presentationProgress,presentationDirection,passedProps}) => {
  const {width,height}=useVideoConfig();
  // Keep the outgoing picture solid. Only a narrow feather at the moving edge
  // blends images; unlike a dissolve, whole headlines never double-expose.
  if(presentationDirection==='exiting')return <AbsoluteFill>{children}</AbsoluteFill>;
  const horizontal=passedProps.direction==='from-right';
  const span=horizontal?width:height;
  const edge=span+passedProps.feather-presentationProgress*(span+2*passedProps.feather);
  const axis=horizontal?'to right':passedProps.direction==='from-bottom'?'to bottom':'to top';
  const mask=`linear-gradient(${axis}, transparent ${edge-passedProps.feather}px, #000 ${edge+passedProps.feather}px)`;
  return <AbsoluteFill style={{maskImage:mask,WebkitMaskImage:mask}}>{children}</AbsoluteFill>;
};

export const softReveal = (props:Partial<RevealProps>={}):TransitionPresentation<RevealProps> => ({
  component:SoftReveal,
  props:{direction:'from-right',feather:64,...props},
});
