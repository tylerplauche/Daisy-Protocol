import {DEFAULT_TIMEOUT,freshSession,isExpired,restoreSession} from './chat-session.js';
(()=>{
 const assets=new URL('.',import.meta.url);
 const key='website-chat-v2';
 class SchedulingChat extends HTMLElement{
  constructor(){super();this.attachShadow({mode:'open'});this.busy=false;this.pending=null;this.timeout=DEFAULT_TIMEOUT;this.session=freshSession();}
  connectedCallback(){
   try{this.session=restoreSession(JSON.parse(localStorage.getItem(key)||'null'),this.timeout);this.pending=this.session.pending||null;}catch{}
   this.shadowRoot.innerHTML=`<link rel="stylesheet" href="${new URL('widget.css',assets).href}"><button class="sc-launch" aria-label="Open chat" aria-haspopup="dialog"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z"/></svg><span>Chat with us</span></button><dialog class="sc-panel" aria-labelledby="sc-title"><header class="sc-header"><div class="sc-avatar" aria-hidden="true">✦</div><div class="sc-heading"><h2 id="sc-title">How can we help?</h2><p>Website assistant</p></div><button class="sc-reset sc-icon" title="New conversation" aria-label="New conversation">↻</button><button class="sc-close sc-icon" aria-label="Close chat">×</button></header><p class="sc-privacy">Ask us about our services or get help with an appointment. Please don’t include sensitive information.</p><div class="sc-log" role="log" aria-live="polite" aria-relevant="additions"></div><div class="sc-typing" role="status" hidden><span></span><span></span><span></span><span class="sc-sr">Assistant is typing</span></div><div class="sc-error" role="alert" hidden><span></span><button type="button">Try again</button></div><form class="sc-form"><label class="sc-sr" for="sc-input">Message the assistant</label><textarea id="sc-input" rows="1" maxlength="2000" placeholder="Type a message…"></textarea><button class="sc-send" type="submit" aria-label="Send message"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m5 12 7-7 7 7M12 5v14"/></svg></button></form><footer class="sc-footer">A little conversation. One less thing to do.</footer></dialog>`;
   this.$=s=>this.shadowRoot.querySelector(s);this.render();this.persist();
   this.$('.sc-launch').onclick=()=>this.open();this.$('.sc-close').onclick=()=>this.$('dialog').close();
   this.$('.sc-reset').onclick=()=>{if(!this.busy)this.reset()};
   this.$('dialog').addEventListener('close',()=>this.$('.sc-launch').focus());
   this.$('form').onsubmit=e=>{e.preventDefault();this.send()};
   this.$('textarea').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();this.send()}};
   this.$('textarea').oninput=()=>this.updateSend();this.$('.sc-error button').onclick=()=>this.pending&&this.send(this.pending);
   this.connectionListener=()=>{if(!navigator.onLine)this.error('You’re offline. Reconnect, then try again.');else if(!this.pending)this.error('')};window.addEventListener('offline',this.connectionListener);window.addEventListener('online',this.connectionListener);this.connectionListener();
   this.configReady=fetch('/api/chat').then(r=>r.ok?r.json():null).then(config=>{if(Number.isFinite(config?.sessionTimeoutMs)&&config.sessionTimeoutMs>=60000)this.timeout=config.sessionTimeoutMs;}).catch(()=>{});
   if(this.pending)this.error('Your last message may still be processing. Try again to retrieve the reply.');
   this.openListener=()=>this.open();document.addEventListener('open-scheduling-chat',this.openListener);
   this.demoListener=e=>{if(e.target.closest?.('[data-open-scheduling]'))this.open()};document.addEventListener('click',this.demoListener);
  }
  disconnectedCallback(){window.removeEventListener('offline',this.connectionListener);window.removeEventListener('online',this.connectionListener);document.removeEventListener('open-scheduling-chat',this.openListener);document.removeEventListener('click',this.demoListener)}
  open(){if(!this.$('dialog').open)this.$('dialog').showModal();this.$('textarea').focus();this.scroll()}
  reset(){this.session=freshSession();this.pending=null;this.error('');this.persist();this.render();this.$('textarea').focus()}
  persist(){this.session.pending=this.pending;try{localStorage.setItem(key,JSON.stringify(this.session))}catch{/* Storage is optional: keep the current conversation in memory. */}}
  render(){const log=this.$('.sc-log');log.replaceChildren();for(const message of this.session.messages){const bubble=document.createElement('div');bubble.className='sc-bubble sc-'+message.role;const who=document.createElement('span');who.className='sc-sr';who.textContent=message.role==='user'?'You: ':'Assistant: ';bubble.append(who,document.createTextNode(message.content));log.append(bubble)}this.scroll();this.updateSend()}
  scroll(){requestAnimationFrame(()=>{const log=this.$('.sc-log');log.scrollTop=log.scrollHeight})}
  updateSend(){this.$('.sc-send').disabled=this.busy||!this.$('textarea').value.trim();this.$('.sc-reset').disabled=this.busy;this.$('.sc-typing').hidden=!this.busy;this.$('textarea').disabled=this.busy;this.$('.sc-error button').disabled=this.busy;}
  error(text){this.$('.sc-error').hidden=!text;this.$('.sc-error span').textContent=text;this.$('.sc-error button').hidden=!this.pending;}
  async send(retry){
   if(this.busy)return;await this.configReady;if(this.busy)return;const message=retry?.message||this.$('textarea').value.trim();if(!message)return;
   if(!navigator.onLine){this.error('You’re offline. Reconnect, then try again.');return;}
   // Expire only when sending, never erase an active visible chat on a timer.
   if(isExpired(this.session,this.timeout)){this.reset();if(retry){this.$('textarea').value=message;this.updateSend();this.error('Your previous conversation expired. Review your message before sending it in this new conversation.');return;}}
   this.session.lastActivityAt=Date.now();
   const request=retry||{sessionId:this.session.sessionId,requestId:crypto.randomUUID(),message};this.pending=request;this.persist();
   if(!retry){this.session.messages.push({role:'user',content:message});this.session.messages=this.session.messages.slice(-60);this.$('textarea').value='';this.persist();this.render()}
   this.busy=true;this.error('');this.updateSend();this.scroll();
   try{const response=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(75000)});const result=await response.json();if(!response.ok){const error=new Error('Chat unavailable');error.status=response.status;error.code=result.code;throw error;}if(typeof result.message!=='string')throw new Error('The reply could not be read. Please try again.');this.session.messages.push({role:'assistant',content:result.message});this.pending=null;this.persist();this.render()}
   catch(error){if(error.code==='SESSION_EXPIRED'){this.reset();this.$('textarea').value=message;this.error('Your previous conversation expired. Review your message before sending it in this new conversation.');}else this.error(!navigator.onLine?'You’re offline. Reconnect, then try again.':error.status===429?'Please wait a minute before trying again.':error.name==='TimeoutError'?'This is taking longer than expected. Try again to retrieve your reply.':'I’m having trouble connecting right now. Please try again in a moment.')}
   finally{this.busy=false;this.updateSend();this.$('textarea').focus();this.scroll()}
  }
 }
 if(!customElements.get('scheduling-chat'))customElements.define('scheduling-chat',SchedulingChat);
})();
