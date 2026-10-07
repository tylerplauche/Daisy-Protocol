(()=>{
 const assets=new URL('.',document.currentScript?.src||location.href);
 const greeting={role:'assistant',content:'Hi! I can help you schedule an appointment. What would you like to book?'};
 const key='scheduling-chat-v1';
 class SchedulingChat extends HTMLElement{
  constructor(){super();this.attachShadow({mode:'open'});this.busy=false;this.pending=null;this.session={sessionId:crypto.randomUUID(),messages:[greeting],updatedAt:Date.now()};}
  connectedCallback(){
   try{const saved=JSON.parse(localStorage.getItem(key)||'null');if(saved&&Date.now()-saved.updatedAt<6*86400000&&/^[a-f\d-]{36}$/i.test(saved.sessionId)&&Array.isArray(saved.messages))this.session={sessionId:saved.sessionId,messages:saved.messages.filter(m=>['user','assistant'].includes(m.role)&&typeof m.content==='string').slice(-60),updatedAt:saved.updatedAt};}catch{}
   this.shadowRoot.innerHTML=`<link rel="stylesheet" href="${new URL('widget.css',assets).href}"><button class="sc-launch" aria-label="Open scheduling chat" aria-haspopup="dialog"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z"/></svg><span>Book an appointment</span></button><dialog class="sc-panel" aria-labelledby="sc-title"><header class="sc-header"><div class="sc-avatar" aria-hidden="true">✦</div><div class="sc-heading"><h2 id="sc-title">Let’s find a time</h2><p>Scheduling assistant</p></div><button class="sc-reset sc-icon" title="Start a new conversation" aria-label="Start a new conversation">↻</button><button class="sc-close sc-icon" aria-label="Close chat">×</button></header><p class="sc-privacy">Share your contact details to arrange an appointment. Please don’t include sensitive information.</p><div class="sc-log" role="log" aria-live="polite" aria-relevant="additions"></div><div class="sc-typing" role="status" hidden><span></span><span></span><span></span><span class="sc-sr">Assistant is typing</span></div><div class="sc-error" role="alert" hidden><span></span><button type="button">Try again</button></div><form class="sc-form"><label class="sc-sr" for="sc-input">Message the scheduling assistant</label><textarea id="sc-input" rows="1" maxlength="2000" placeholder="Type a message…"></textarea><button class="sc-send" type="submit" aria-label="Send message"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m5 12 7-7 7 7M12 5v14"/></svg></button></form><footer class="sc-footer">A little conversation. One less thing to do.</footer></dialog>`;
   this.$=s=>this.shadowRoot.querySelector(s);this.render();this.persist();
   this.$('.sc-launch').onclick=()=>this.open();this.$('.sc-close').onclick=()=>this.$('dialog').close();
   this.$('.sc-reset').onclick=()=>{if(this.busy)return;if(!confirm('Start a fresh conversation? This clears the chat on this device and does not cancel an existing appointment.'))return;this.session={sessionId:crypto.randomUUID(),messages:[greeting],updatedAt:Date.now()};this.pending=null;this.error('');this.persist();this.render();this.$('textarea').focus()};
   this.$('form').onsubmit=e=>{e.preventDefault();this.send()};
   this.$('textarea').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();this.send()}};
   this.$('textarea').oninput=()=>this.updateSend();this.$('.sc-error button').onclick=()=>this.pending&&this.send(this.pending);
   this.openListener=()=>this.open();document.addEventListener('open-scheduling-chat',this.openListener);
   this.demoListener=e=>{if(e.target.closest?.('[data-open-scheduling]'))this.open()};document.addEventListener('click',this.demoListener);
  }
  disconnectedCallback(){document.removeEventListener('open-scheduling-chat',this.openListener);document.removeEventListener('click',this.demoListener)}
  open(){if(!this.$('dialog').open)this.$('dialog').showModal();this.$('textarea').focus();this.scroll()}
  persist(){this.session.updatedAt=Date.now();try{localStorage.setItem(key,JSON.stringify(this.session))}catch{/* Storage is optional: keep the current conversation in memory. */}}
  render(){const log=this.$('.sc-log');log.replaceChildren();for(const message of this.session.messages){const bubble=document.createElement('div');bubble.className='sc-bubble sc-'+message.role;const who=document.createElement('span');who.className='sc-sr';who.textContent=message.role==='user'?'You: ':'Assistant: ';bubble.append(who,document.createTextNode(message.content));log.append(bubble)}this.scroll();this.updateSend()}
  scroll(){requestAnimationFrame(()=>{const log=this.$('.sc-log');log.scrollTop=log.scrollHeight})}
  updateSend(){this.$('.sc-send').disabled=this.busy||!this.$('textarea').value.trim();this.$('.sc-reset').disabled=this.busy;this.$('.sc-typing').hidden=!this.busy;this.$('textarea').disabled=this.busy;this.$('.sc-error button').disabled=this.busy;}
  error(text){this.$('.sc-error').hidden=!text;this.$('.sc-error span').textContent=text;this.$('.sc-error button').hidden=!this.pending;}
  async send(retry){
   if(this.busy)return;const message=retry?.message||this.$('textarea').value.trim();if(!message)return;
   const request=retry||{sessionId:this.session.sessionId,requestId:crypto.randomUUID(),message};this.pending=request;
   if(!retry){this.session.messages.push({role:'user',content:message});this.session.messages=this.session.messages.slice(-60);this.$('textarea').value='';this.persist();this.render()}
   this.busy=true;this.error('');this.updateSend();this.scroll();
   try{const response=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(75000)});const result=await response.json();if(!response.ok)throw new Error(result.error||'Something went wrong. Please try again.');if(typeof result.message!=='string')throw new Error('The reply could not be read. Please try again.');this.session.messages.push({role:'assistant',content:result.message});this.pending=null;this.persist();this.render()}
   catch(error){this.error(error.name==='TimeoutError'?'This is taking longer than expected. Try again to retrieve your reply.':error.message||'Connection interrupted. Please try again.')}
   finally{this.busy=false;this.updateSend();this.$('textarea').focus();this.scroll()}
  }
 }
 if(!customElements.get('scheduling-chat'))customElements.define('scheduling-chat',SchedulingChat);
})();
