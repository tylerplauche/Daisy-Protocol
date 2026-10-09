'use client';
import {useEffect,useRef} from 'react';
export default function SchedulingChat(){
 const host=useRef<HTMLDivElement>(null);
 useEffect(()=>{
  if(!document.querySelector('script[data-scheduling-widget]')){const script=document.createElement('script');script.src='/scheduling/widget.js';script.type='module';script.dataset.schedulingWidget='true';script.defer=true;document.body.appendChild(script)}
  const element=document.createElement('scheduling-chat');host.current?.appendChild(element);return()=>{element.remove()};
 },[]);
 return <div ref={host}/>;
}
