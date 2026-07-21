import React from 'react';
import './App.css';

const FeedbackForm = () => {
    return (
        <div className="container">
            <h1>Your Company Feedback</h1>
            <form>
                <section>
                    <label htmlFor="email">Email:</label>
                    <input type="email" id="email" name="email" required placeholder="you@example.com" />
                </section>
                <section>
                    <label>Rating:</label>
                    <div className="ratings">
                        {[1, 2, 3, 4, 5].map((rating) => (
                            <div key={rating} className="rating-button">{rating}</div>
                        ))}
                    </div>
                </section>
                <section>
                    <label htmlFor="comments">Comments:</label>
                    <textarea id="comments" name="comments" rows="4" placeholder="Your feedback here..." required></textarea>
                </section>
                <button type="submit" className="submit-btn">Submit Feedback</button>
            </form>
        </div>
    );
};

export default FeedbackForm;