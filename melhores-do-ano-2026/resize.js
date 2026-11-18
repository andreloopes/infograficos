/* Emits only the public card identifier and rendered height; no user data. */
(()=>{const main=document.querySelector('main');if(!main)return;const report=()=>parent.postMessage({type:'exame-product-height',id:main.dataset.cardId,height:Math.ceil(main.getBoundingClientRect().height)},'*');new ResizeObserver(report).observe(main);window.addEventListener('load',report);report();})();
