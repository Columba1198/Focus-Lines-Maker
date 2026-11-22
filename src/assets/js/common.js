// フッターの年を更新
document.addEventListener('DOMContentLoaded', () => {
    (function() {
        // 新しいDateオブジェクトから今年の年を取得
        const currentYear = new Date().getFullYear();
        // span要素にテキストとして挿入
        document.getElementById('year').textContent = currentYear;
    })();
});