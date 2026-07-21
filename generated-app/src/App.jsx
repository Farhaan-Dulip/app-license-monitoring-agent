import './App.css';

const FeedbackForm = () => {
  const handleStarClick = (event) => {
    const stars = document.querySelectorAll('.star');
    stars.forEach(star => star.classList.remove('selected'));
    event.currentTarget.classList.add('selected');
    stars.forEach(s => {
      if (s.dataset.value <= event.currentTarget.dataset.value) {
        s.classList.add('selected');
      }
    });
  };

  return (
    <div className="container">
      <h1>Submit Your Feedback</h1>
      <form>
        <label htmlFor="email">Email:</label>
        <input type="email" id="email" name="email" required />

        <div className="rating">
          {[1, 2, 3, 4, 5].map(value => (
            <span key={value} className="star" data-value={value} onClick={handleStarClick}>★</span>
          ))}
        </div>

        <label htmlFor="comments">Comments:</label>
        <textarea id="comments" name="comments" rows="4"></textarea>

        <button type="submit">Submit Feedback</button>
      </form>
    </div>
  );
};

export default FeedbackForm;