"use client";
import * as Dialog from "@radix-ui/react-dialog";
import { useLayoutEffect, useRef } from "react";
import { X } from "./icons";

type Props={ className?: string; trigger?: React.ReactNode; title: string; description?: string; children: React.ReactNode; open?: boolean; onOpenChange?: (value:boolean)=>void; onCloseAutoFocus?: (event:Event)=>void; onEscapeKeyDown?: (event:KeyboardEvent)=>void };

export function AppDialog({ trigger, title, description, children, open, onOpenChange, className, onCloseAutoFocus, onEscapeKeyDown }: Props) {
  // Controlled dialogs have no Radix trigger, so remember the opener and restore focus to it on close.
  const opener=useRef<HTMLElement|null>(null);
  useLayoutEffect(()=>{if(open&&document.activeElement instanceof HTMLElement&&document.activeElement!==document.body)opener.current=document.activeElement},[open]);
  function restore(event:Event){
    onCloseAutoFocus?.(event);
    if(event.defaultPrevented)return;
    const target=opener.current;opener.current=null;
    if(target?.isConnected){event.preventDefault();target.focus()}
  }
  return <Dialog.Root open={open} onOpenChange={onOpenChange}>{trigger&&<Dialog.Trigger asChild>{trigger}</Dialog.Trigger>}<Dialog.Portal><Dialog.Overlay className="dialog-overlay"/><Dialog.Content className={`dialog-content ${className ?? ""}`} onCloseAutoFocus={restore} onEscapeKeyDown={onEscapeKeyDown}><Dialog.Title>{title}</Dialog.Title>{description&&<Dialog.Description className="dialog-description">{description}</Dialog.Description>}<Dialog.Close className="icon-button dialog-close" aria-label="關閉"><X size={20}/></Dialog.Close>{children}</Dialog.Content></Dialog.Portal></Dialog.Root>;
}
