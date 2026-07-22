import './App.css';
import { useState } from 'react';

const FeedbackForm = () => {
    const [rating, setRating] = useState(0);

    const handleSubmit = (event) => {
        event.preventDefault();
        alert(`Feedback Submitted! Rating: ${rating}`);
    };

    return (
        <div className="container">
            <h1>Feedback Hub</h1>
            <form onSubmit={handleSubmit}>
                <label htmlFor="email">Email:</label>
                <input type="email" id="email" required />

                <label>Rating:</label>
                <div className="rating">
                    {[1, 2, 3, 4, 5].map((value) => (
                        <span key={value} className={`star ${value <= rating ? 'selected' : ''}`} onClick={() => setRating(value)}>
                            ★
                        </span>
                    ))}
                </div>

                <label htmlFor="comments">Comments:</label>
                <textarea id="comments" rows="4" required></textarea>

                <button type="submit">Submit Feedback</button>
            </form>
        </div>
    );
};

export default FeedbackForm;