import './App.css';

const FeedbackForm = () => {
    return (
        <div className="container">
            <h1>Feedback Hub</h1>
            <div className="form-group">
                <label htmlFor="email">Email</label>
                <input type="email" id="email" required />
            </div>
            <div className="form-group">
                <label>Rating</label>
                <div className="rating">
                    <label className="star">★</label>
                    <label className="star">★</label>
                    <label className="star">★</label>
                    <label className="star">★</label>
                    <label className="star">★</label>
                </div>
            </div>
            <div className="form-group">
                <label htmlFor="comments">Comments</label>
                <textarea id="comments" rows="4" required></textarea>
            </div>
            <button type="submit">Submit Feedback</button>
        </div>
    );
};

export default FeedbackForm;